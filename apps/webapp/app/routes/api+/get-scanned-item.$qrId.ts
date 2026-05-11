import type { Prisma } from "@prisma/client";
import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { getQr } from "~/modules/qr/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  payload,
  error,
  getCurrentSearchParams,
  getParams,
  parseData,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import type {
  AssetFromScanner,
  KitFromScanner,
} from "~/utils/scanner-includes.server";
import {
  ASSET_INCLUDE,
  KIT_INCLUDE,
  QR_INCLUDE,
} from "~/utils/scanner-includes.server";
import { parseSequentialId } from "~/utils/sequential-id";

// Re-export types for backward compatibility
export type AssetFromQr = AssetFromScanner;
export type KitFromQr = KitFromScanner;

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const searchParams = getCurrentSearchParams(request);

  try {
    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.qr,
      action: PermissionAction.read,
    });
    const { organizationId, isCustomer, carbonCustomerId } = perm;

    /**
     * Returns true if a CUSTOMER user is allowed to see this asset's data.
     * Visible = (customer owns the asset) OR (Fieldkit-owned rentable pool).
     * For non-CUSTOMER roles, returns true unconditionally.
     */
    const assetVisibleToCustomer = (asset: {
      carbonCustomerId: string | null;
      rentable: boolean;
    }) => {
      if (!isCustomer) return true;
      if (asset.carbonCustomerId === carbonCustomerId) return true;
      return asset.carbonCustomerId === null && asset.rentable === true;
    };

    /**
     * Same predicate for kits (mirrors Asset semantics — kits also have
     * carbonCustomerId + rentable fields).
     */
    const kitVisibleToCustomer = (kit: {
      carbonCustomerId: string | null;
      rentable: boolean;
    }) => {
      if (!isCustomer) return true;
      if (kit.carbonCustomerId === carbonCustomerId) return true;
      return kit.carbonCustomerId === null && kit.rentable === true;
    };

    /**
     * Builds the "unknown QR" error. We return the same shape for both
     * truly-unknown QRs and QRs that resolve to assets/kits this CUSTOMER
     * cannot see, so customers can't enumerate other customers' QRs by
     * timing or error-message differentials.
     */
    const unknownQrError = () =>
      new ShelfError({
        cause: null,
        message:
          "This code doesn't exist or it doesn't belong to your current organization.",
        additionalData: { qrId: params.qrId, shouldSendNotification: false },
        label: "QR",
        shouldBeCaptured: false,
      });

    const { qrId } = getParams(params, z.object({ qrId: z.string() }), {
      additionalData: {
        userId,
      },
    });

    const { assetExtraInclude, kitExtraInclude, auditSessionId } = parseData(
      searchParams,
      z.object({
        assetExtraInclude: z
          .string()
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            try {
              return JSON.parse(val);
            } catch (_error) {
              throw new Error("Invalid JSON input for assetExtraInclude");
            }
          }),
        kitExtraInclude: z
          .string()
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            try {
              return JSON.parse(val);
            } catch (_error) {
              throw new Error("Invalid JSON input for kitExtraInclude");
            }
          }),
        auditSessionId: z.string().optional(),
      })
    ) as {
      assetExtraInclude: Prisma.AssetInclude | undefined;
      kitExtraInclude: Prisma.KitInclude | undefined;
      auditSessionId?: string;
    };

    const assetInclude: Prisma.AssetInclude = {
      ...ASSET_INCLUDE,
      ...(assetExtraInclude ?? {}),
    };

    const kitInclude: Prisma.KitInclude = {
      ...KIT_INCLUDE,
      ...(kitExtraInclude ?? {}),
    };

    const sequentialId = parseSequentialId(qrId);

    if (sequentialId) {
      const asset = await db.asset.findFirst({
        where: {
          organizationId,
          sequentialId,
        },
        include: assetInclude,
      });

      if (!asset) {
        throw new ShelfError({
          cause: null,
          message:
            "This SAM ID doesn't exist or it doesn't belong to your current organization.",
          title: "SAM ID not found",
          additionalData: { sequentialId, shouldSendNotification: false },
          label: "Scan",
          shouldBeCaptured: false,
        });
      }

      // Customer-tenancy guard. Return the same unknown-QR error shape rather
      // than a 403 so CUSTOMER users can't enumerate other customers' SAM IDs.
      if (!assetVisibleToCustomer(asset)) {
        throw unknownQrError();
      }

      // If audit session ID provided, fetch the auditAssetId and counts
      let auditAssetId: string | undefined;
      let auditNotesCount = 0;
      let auditImagesCount = 0;
      if (auditSessionId && asset.id) {
        const auditAsset = await db.auditAsset.findFirst({
          where: {
            auditSessionId,
            assetId: asset.id,
          },
          select: { id: true },
        });
        auditAssetId = auditAsset?.id;
        if (auditAssetId) {
          const [notesCount, imagesCount] = await Promise.all([
            db.auditNote.count({
              where: {
                auditSessionId,
                auditAssetId,
              },
            }),
            db.auditImage.count({
              where: {
                auditSessionId,
                auditAssetId,
              },
            }),
          ]);
          auditNotesCount = notesCount;
          auditImagesCount = imagesCount;
        }
      }

      return data(
        payload({
          qr: {
            type: "asset" as const,
            asset: {
              ...asset,
              auditAssetId,
              auditNotesCount,
              auditImagesCount,
            },
          },
        })
      );
    }

    const include = {
      ...QR_INCLUDE,
      asset: { include: assetInclude },
      kit: { include: kitInclude },
    };

    const qr = await getQr({
      id: qrId,
      include,
    });

    if (qr.organizationId !== organizationId) {
      throw new ShelfError({
        cause: null,
        message:
          "This code doesn't exist or it doesn't belong to your current organization.",
        additionalData: { qrId, shouldSendNotification: false },
        label: "QR",
        shouldBeCaptured: false,
      });
    }

    if (!qr.assetId && !qr.kitId) {
      throw new ShelfError({
        cause: null,
        message: "QR code is not linked to any asset or kit",
        additionalData: { qrId, shouldSendNotification: false },
        shouldBeCaptured: false,
        label: "QR",
      });
    }

    // Customer-tenancy guard on QR-resolved asset/kit. Same unknown-QR error
    // shape on mismatch so CUSTOMER users can't enumerate other customers'
    // codes via error-message differentials.
    if (qr.asset && !assetVisibleToCustomer(qr.asset)) {
      throw unknownQrError();
    }
    if (qr.kit && !kitVisibleToCustomer(qr.kit)) {
      throw unknownQrError();
    }

    // If audit session ID provided, fetch the auditAssetId and counts
    let auditAssetId: string | undefined;
    let auditNotesCount = 0;
    let auditImagesCount = 0;
    if (auditSessionId && qr.asset?.id) {
      const auditAsset = await db.auditAsset.findFirst({
        where: {
          auditSessionId,
          assetId: qr.asset.id,
        },
        select: { id: true },
      });
      auditAssetId = auditAsset?.id;
      if (auditAssetId) {
        const [notesCount, imagesCount] = await Promise.all([
          db.auditNote.count({
            where: {
              auditSessionId,
              auditAssetId,
            },
          }),
          db.auditImage.count({
            where: {
              auditSessionId,
              auditAssetId,
            },
          }),
        ]);
        auditNotesCount = notesCount;
        auditImagesCount = imagesCount;
      }
    }

    return data(
      payload({
        qr: {
          ...qr,
          type: qr.asset ? "asset" : qr.kit ? "kit" : undefined,
          asset: qr.asset
            ? {
                ...qr.asset,
                auditAssetId,
                auditNotesCount,
                auditImagesCount,
              }
            : undefined,
        },
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    const sendNotification = reason.additionalData?.shouldSendNotification;
    const shouldSendNotification =
      typeof sendNotification === "boolean" && sendNotification;

    return data(error(reason, shouldSendNotification), {
      status: reason.status,
    });
  }
}
