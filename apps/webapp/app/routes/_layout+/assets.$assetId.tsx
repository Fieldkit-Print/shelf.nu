import { BarcodeType } from "@prisma/client";
import { DateTime } from "luxon";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, data, Form, useLoaderData, Outlet } from "react-router";
import { z } from "zod";
import { setReminderSchema } from "~/components/asset-reminder/set-or-edit-reminder-dialog";
import ActionsDropdown from "~/components/assets/actions-dropdown";
import { AssetImage } from "~/components/assets/asset-image/component";
import { AssetStatusBadge } from "~/components/assets/asset-status-badge";
import BookingActionsDropdown from "~/components/assets/booking-actions-dropdown";
import Header from "~/components/layout/header";

import type { HeaderData } from "~/components/layout/header/types";
import HorizontalTabs from "~/components/layout/horizontal-tabs";
import { Button } from "~/components/shared/button";
import When from "~/components/when/when";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import {
  deleteAsset,
  deleteOtherImages,
  getAsset,
  relinkAssetQrCode,
} from "~/modules/asset/service.server";
import { createAssetReminder } from "~/modules/asset-reminder/service.server";
import { createBarcode } from "~/modules/barcode/service.server";
import {
  validateBarcodeValue,
  normalizeBarcodeValue,
} from "~/modules/barcode/validation";
import { listCustomers as listCarbonCustomers } from "~/modules/carbon-sync/client.server";
import assetCss from "~/styles/asset.css?url";

import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { checkExhaustiveSwitch } from "~/utils/check-exhaustive-switch";
import { getHints } from "~/utils/client-hints";
import { DATE_TIME_FORMAT } from "~/utils/constants";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError } from "~/utils/error";
import {
  error,
  getParams,
  payload,
  parseData,
  safeRedirect,
} from "~/utils/http.server";
import { buildCustomerAssetScope } from "~/utils/permissions/customer-scope.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

export const AvailabilityForBookingFormSchema = z.object({
  availableToBook: z
    .string()
    .transform((val) => val === "on")
    .default("false"),
});

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const perm = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    });
    const { organizationId, userOrganizations } = perm;

    const asset = await getAsset({
      id,
      organizationId,
      userOrganizations,
      request,
      include: {
        custody: { include: { custodian: true } },
        kit: true,
        qrCodes: true,
        // Fieldkit: `Asset.carbonCustomerId` is a text reference into Carbon
        // (no FK / local Customer model). Display layer reads the customer
        // name via `carbon_remote.v1_customers` FDW or REST as needed.
      },
      // Fieldkit multi-tenancy: customer-role users see only their own assets.
      // CUSTOMER must `includeRentable` here so the rentable detail page
      // continues to load when they navigate to a rentable item.
      customerScope: buildCustomerAssetScope(perm, { includeRentable: true }),
    });

    const header: HeaderData = {
      title: asset.title,
    };

    // Fieldkit: load the Carbon customer list for the customer-assignment
    // UI on this page. Staff-only — CUSTOMER role users don't see the
    // assignment widget, so we skip the REST call for them.
    let carbonCustomers: { id: string; name: string }[] = [];
    if (!perm.isCustomer) {
      try {
        carbonCustomers = await listCarbonCustomers();
      } catch {
        // Carbon REST may be misconfigured / down; degrade gracefully.
        // The assignment widget just won't render its dropdown.
        carbonCustomers = [];
      }
    }

    return payload({
      asset,
      header,
      carbonCustomers,
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { assetId: id } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const formData = await request.formData();

    const { intent } = parseData(
      formData,
      z.object({
        intent: z.enum([
          "delete",
          "relink-qr-code",
          "set-reminder",
          "add-barcode",
        ]),
      })
    );

    const intent2ActionMap: { [K in typeof intent]: PermissionAction } = {
      delete: PermissionAction.delete,
      "relink-qr-code": PermissionAction.update,
      "set-reminder": PermissionAction.update,
      "add-barcode": PermissionAction.update,
    };

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: intent2ActionMap[intent],
    });

    switch (intent) {
      case "delete": {
        const { mainImageUrl } = parseData(
          formData,
          z.object({ mainImageUrl: z.string().optional() })
        );

        await deleteAsset({ organizationId, id });

        if (mainImageUrl) {
          // as it is deletion operation giving hardcoded path(to make sure all the images were deleted)
          await deleteOtherImages({
            userId,
            assetId: id,
            data: { path: `main-image-${id}.jpg` },
          });
        }

        sendNotification({
          title: "Asset deleted",
          message: "Your asset has been deleted successfully",
          icon: { name: "trash", variant: "error" },
          senderId: authSession.userId,
        });

        return redirect("/assets");
      }

      case "relink-qr-code": {
        const { newQrId } = parseData(
          formData,
          z.object({ newQrId: z.string() })
        );

        await relinkAssetQrCode({
          qrId: newQrId,
          assetId: id,
          organizationId,
          userId,
        });

        sendNotification({
          title: "QR Relinked",
          message: "A new qr code has been linked to your asset.",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return payload({ success: true });
      }

      case "set-reminder": {
        const { redirectTo, ...payload } = parseData(
          formData,
          setReminderSchema,
          { shouldBeCaptured: false }
        );
        const hints = getHints(request);

        const alertDateTime = DateTime.fromFormat(
          formData.get("alertDateTime")!.toString()!,
          DATE_TIME_FORMAT,
          {
            zone: hints.timeZone,
          }
        ).toJSDate();

        await createAssetReminder({
          ...payload,
          assetId: id,
          alertDateTime,
          organizationId,
          createdById: userId,
        });

        sendNotification({
          title: "Reminder created",
          message: "A reminder for you asset has been created successfully.",
          icon: { name: "success", variant: "success" },
          senderId: authSession.userId,
        });

        return redirect(safeRedirect(redirectTo));
      }

      case "add-barcode": {
        const { barcodeType, barcodeValue } = parseData(
          formData,
          z.object({
            barcodeType: z.nativeEnum(BarcodeType),
            barcodeValue: z.string().min(1, "Barcode value is required"),
          })
        );

        // Validate barcode value
        const normalizedValue = normalizeBarcodeValue(
          barcodeType,
          barcodeValue
        );
        const validationError = validateBarcodeValue(
          barcodeType,
          normalizedValue
        );

        if (validationError) {
          return data(payload({ error: validationError }), { status: 400 });
        }

        try {
          await createBarcode({
            type: barcodeType,
            value: normalizedValue,
            organizationId,
            userId,
            assetId: id,
          });

          sendNotification({
            title: "Barcode added",
            message: "Barcode has been added to your asset successfully",
            icon: { name: "success", variant: "success" },
            senderId: authSession.userId,
          });

          return payload({ success: true });
        } catch (cause) {
          // Handle constraint violations and other barcode creation errors
          const reason = makeShelfError(cause);

          // Extract specific validation errors if they exist
          const validationErrors = reason.additionalData
            ?.validationErrors as any;
          if (validationErrors && validationErrors["barcodes[0].value"]) {
            return data(
              payload({ error: validationErrors["barcodes[0].value"].message }),
              {
                status: reason.status,
              }
            );
          }

          return data(payload({ error: reason.message }), {
            status: reason.status,
          });
        }
      }

      default: {
        checkExhaustiveSwitch(intent);
        return payload(null);
      }
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, id });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header?.title) },
];

export const handle = {
  breadcrumb: () => "single",
};

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: assetCss },
];

export default function AssetDetailsPage() {
  const { asset, carbonCustomers } = useLoaderData<typeof loader>();

  const { roles, isCustomer } = useUserRoleHelper();
  const canAssignCustomer = userHasPermission({
    roles,
    entity: PermissionEntity.customer,
    action: PermissionAction.update,
  });

  const items = [
    { to: "overview", content: "Overview" },
    { to: "activity", content: "Activity" },
    { to: "bookings", content: "Bookings" },
    ...(userHasPermission({
      roles,
      entity: PermissionEntity.assetReminders,
      action: PermissionAction.read,
    })
      ? [{ to: "reminders", content: "Reminders" }]
      : []),
  ];

  return (
    <div className="relative">
      <Header
        slots={{
          "left-of-title": (
            <AssetImage
              key={asset.id}
              asset={{
                id: asset.id,
                mainImage: asset.mainImage,
                thumbnailImage: asset.thumbnailImage,
                mainImageExpiration: asset.mainImageExpiration,
              }}
              alt={`Image of ${asset.title}`}
              className={tw(
                "mr-4 size-14 cursor-pointer rounded border object-cover"
              )}
              withPreview
            />
          ),
        }}
        subHeading={
          <div className="flex gap-2">
            <AssetStatusBadge
              id={asset.id}
              status={asset.status}
              availableToBook={asset.availableToBook}
            />
          </div>
        }
      >
        <When
          truthy={userHasPermission({
            roles,
            entity: PermissionEntity.asset,
            action: [PermissionAction.update, PermissionAction.custody],
          })}
        >
          <ActionsDropdown />
        </When>
        <BookingActionsDropdown />
      </Header>
      <HorizontalTabs items={items} />
      {canAssignCustomer && !isCustomer ? (
        <CustomerAssignmentCard
          assetId={asset.id}
          currentCarbonCustomerId={asset.carbonCustomerId}
          carbonCustomers={carbonCustomers}
        />
      ) : null}
      <div>
        <Outlet />
      </div>
    </div>
  );
}

/**
 * Inline card on the asset detail page that lets staff assign or clear
 * which Carbon customer this asset is stored for. Submits to the existing
 * `/api/customers/assign-assets` endpoint (intent `assign-customer`,
 * `assetIds = [this asset]`). On success the loader revalidates and the
 * card re-renders with the new selection.
 */
function CustomerAssignmentCard({
  assetId,
  currentCarbonCustomerId,
  carbonCustomers,
}: {
  assetId: string;
  currentCarbonCustomerId: string | null;
  carbonCustomers: { id: string; name: string }[];
}) {
  const currentCustomerName = currentCarbonCustomerId
    ? carbonCustomers.find((c) => c.id === currentCarbonCustomerId)?.name ??
      null
    : null;
  return (
    <div className="my-4 rounded border border-gray-200 bg-white p-4 md:p-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Stored for customer
          </h3>
          <p className="text-xs text-gray-500">
            {currentCarbonCustomerId
              ? `Currently assigned to ${
                  currentCustomerName ??
                  "(unknown customer — id " + currentCarbonCustomerId + ")"
                }.`
              : "Not assigned — this asset is currently Fieldkit-owned inventory."}
          </p>
        </div>
      </div>
      <Form
        method="post"
        action="/api/customers/assign-assets"
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="intent" value="assign-customer" />
        <input type="hidden" name="assetIds" value={assetId} />
        <select
          name="carbonCustomerId"
          defaultValue={currentCarbonCustomerId ?? ""}
          className="min-w-[260px] rounded border border-gray-200 px-3 py-1.5 text-sm"
        >
          <option value="">— Not assigned (Fieldkit-owned) —</option>
          {carbonCustomers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="secondary">
          Save
        </Button>
      </Form>
    </div>
  );
}
