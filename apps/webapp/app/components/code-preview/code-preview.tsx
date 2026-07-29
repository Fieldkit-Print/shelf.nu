import React, { useRef, useMemo, useState, useEffect } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type { BarcodeType } from "@prisma/client";
import { changeDpiDataUrl } from "changedpi";
import { toPng } from "html-to-image";
import { useReactToPrint } from "react-to-print";
import { BarcodeDisplay } from "~/components/barcode/barcode-display";
import { Button } from "~/components/shared/button";
import { useCurrentOrganization } from "~/hooks/use-current-organization";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { resolveShowShelfBranding } from "~/utils/branding";
import { useBarcodePermissions } from "~/utils/permissions/use-barcode-permissions";
import { slugify } from "~/utils/slugify";
import { tw } from "~/utils/tw";
import { waitForImagesToLoad } from "~/utils/wait-for-images";
import { AddBarcodeDialog } from "./add-barcode-dialog";
import { Ean13LookupLink } from "../barcode/barcode-card";
import { UnlockBarcodesModal } from "../barcode/unlock-barcodes-banner";
import { CrispButton } from "../marketing/crisp";
import When from "../when/when";

type SizeKeys = "cable" | "small" | "medium" | "large";

export interface CodeType {
  id: string;
  type: "qr" | "barcode";
  label: string;
  // QR specific
  qrData?: {
    size: SizeKeys;
    src: string;
  };
  // Barcode specific
  barcodeData?: {
    type: BarcodeType;
    value: string;
  };
}

/**
 * Module-scope default for the `barcodes` prop. Using a fresh `[]` as the
 * default value triggers identity churn through `useMemo`/`useEffect` dep
 * arrays on every render, so we share a single frozen reference instead.
 */
const EMPTY_BARCODES: Array<{
  id: string;
  type: BarcodeType;
  value: string;
}> = [];

/** Shared frame/container style for QR + barcode labels (rendered for export/print). */
const LABEL_CONTAINER_STYLE: CSSProperties = {
  width: "300px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: "12px",
  borderRadius: "4px",
  border: "5px solid #E3E4E8",
  padding: "24px 17px 24px 17px",
  backgroundColor: "white",
};

/** QR labels are square; barcode labels have a minimum height instead. */
const QR_LABEL_STYLE: CSSProperties = {
  ...LABEL_CONTAINER_STYLE,
  aspectRatio: "1 / 1",
};

const BARCODE_LABEL_STYLE: CSSProperties = {
  ...LABEL_CONTAINER_STYLE,
  minHeight: "300px",
};

/** Title text at the top of a QR/barcode label — truncated, bold, centered. */
const LABEL_TITLE_STYLE: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
  color: "black",
  textAlign: "center",
};

/**
 * Page rule for QR label printing. Defaults the print dialog to standard
 * 2" x 1" label stock (landscape) with no margins so the label fills the
 * physical sticker exactly.
 */
const QR_PRINT_PAGE_STYLE = `
  @page {
    size: 2in 1in;
    margin: 0;
  }
  @media print {
    html, body {
      margin: 0 !important;
      padding: 0 !important;
    }
  }
`;

/**
 * Print-only QR label container sized to fill a 2" x 1" label. Horizontal
 * layout: QR code on the left, title/ID/branding on the right. CSS inch
 * units map 1:1 to physical inches when printed.
 */
const QR_PRINT_LABEL_STYLE: CSSProperties = {
  width: "2in",
  height: "1in",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "0.08in",
  padding: "0.06in",
  boxSizing: "border-box",
  backgroundColor: "white",
  overflow: "hidden",
};

/** QR image on the 2" x 1" print label — square, nearly full label height. */
const QR_PRINT_IMAGE_STYLE: CSSProperties = {
  width: "0.88in",
  height: "0.88in",
  flexShrink: 0,
};

/** Text column next to the QR image on the 2" x 1" print label. */
const QR_PRINT_TEXT_COLUMN_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  minWidth: 0,
  flex: 1,
  color: "black",
};

/** Item title on the 2" x 1" print label — single line, truncated. */
const QR_PRINT_TITLE_STYLE: CSSProperties = {
  fontSize: "8pt",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** QR/SAM id on the 2" x 1" print label. */
const QR_PRINT_ID_STYLE: CSSProperties = {
  fontSize: "7pt",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** "Powered by shelf.nu" branding line on the 2" x 1" print label. */
const QR_PRINT_BRANDING_STYLE: CSSProperties = {
  fontSize: "6pt",
};

/**
 * Resolves which identifier to show on a QR label: the workspace's SAM id
 * when that display preference is active (and one exists), otherwise the
 * QR code's own id.
 */
function resolveQrDisplayId(
  qrId?: string,
  qrIdDisplayPreference?: string,
  sequentialId?: string | null
) {
  return qrIdDisplayPreference === "SAM_ID" && sequentialId
    ? sequentialId
    : qrId;
}

interface CodePreviewProps {
  className?: string;
  style?: CSSProperties;
  hideButton?: boolean;
  item: {
    id: string; // Need the ID to construct the action URL
    name: string;
    type: "asset" | "kit";
  };
  qrObj?: {
    qr?: {
      size: SizeKeys;
      id: string;
      src: string;
    };
  };
  barcodes?: Array<{
    id: string;
    type: BarcodeType;
    value: string;
  }>;
  onCodeChange?: (code: CodeType | null) => void;
  selectedBarcodeId?: string;
  onRefetchData?: () => void; // Callback to refetch data when barcode is added
  sequentialId?: string | null;
  showShelfBranding?: boolean;
}

// react-doctor:no-giant-component — deferred for follow-up refactor
export const CodePreview = ({
  className,
  style,
  qrObj,
  barcodes = EMPTY_BARCODES,
  item,
  hideButton = false,
  onCodeChange,
  selectedBarcodeId,
  onRefetchData,
  sequentialId,
  showShelfBranding,
}: CodePreviewProps) => {
  const captureDivRef = useRef<HTMLImageElement>(null);
  /** Off-screen 2" x 1" QR label used as the print source (QR codes only). */
  const printLabelRef = useRef<HTMLDivElement>(null);
  const downloadBtnRef = useRef<HTMLAnchorElement>(null);
  const { canUseBarcodes } = useBarcodePermissions();
  const { isBaseOrSelfService, isOwner } = useUserRoleHelper();
  const organization = useCurrentOrganization();
  const resolvedShowShelfBranding = resolveShowShelfBranding(
    showShelfBranding,
    organization?.showShelfBranding
  );
  const [isAddBarcodeDialogOpen, setIsAddBarcodeDialogOpen] = useState(false);

  // Build available codes list
  const availableCodes: CodeType[] = useMemo(() => {
    const codes: CodeType[] = [];

    // Add QR code if available
    if (qrObj?.qr) {
      codes.push({
        id: qrObj.qr.id,
        type: "qr",
        label: "Shelf QR Code",
        qrData: {
          size: qrObj.qr.size,
          src: qrObj.qr.src,
        },
      });
    }

    // Add barcodes if available and permissions allow
    if (canUseBarcodes) {
      barcodes.forEach((barcode) => {
        const isExternalQr = barcode.type === "ExternalQR";
        const label = isExternalQr
          ? "External QR Code"
          : `${barcode.type} - ${barcode.value}`;

        codes.push({
          id: barcode.id,
          type: "barcode",
          label,
          barcodeData: {
            type: barcode.type,
            value: barcode.value,
          },
        });
      });
    }

    return codes;
  }, [qrObj, barcodes, canUseBarcodes]);

  // Default to selected barcode, then QR code if available, otherwise first barcode
  const [selectedCodeId, setSelectedCodeId] = useState<string>(() => {
    // If a specific barcode is selected, prioritize it
    if (selectedBarcodeId) {
      const selectedBarcode = availableCodes.find(
        (code) => code.id === selectedBarcodeId
      );
      if (selectedBarcode) {
        return selectedBarcodeId;
      }
    }

    // Otherwise default to QR code if available, then first barcode
    const qrCode = availableCodes.find((code) => code.type === "qr");
    return qrCode?.id || availableCodes[0]?.id || "";
  });

  // Notify parent of initial selection (moved to useEffect to avoid render-time side effects)
  useEffect(() => {
    const selectedBarcode = availableCodes.find(
      (code) => code.id === selectedCodeId
    );
    if (onCodeChange && selectedBarcode) {
      onCodeChange(selectedBarcode);
    }
  }, [selectedCodeId, availableCodes, onCodeChange]);

  const selectedCode = availableCodes.find(
    (code) => code.id === selectedCodeId
  );

  useEffect(() => {
    // Keep selection in sync when codes change (e.g., new QR after relink)
    const hasSelectedCode = availableCodes.some(
      (code) => code.id === selectedCodeId
    );

    if (hasSelectedCode) return;

    // Prefer the externally requested barcode, then fallback to QR, then any barcode
    const selectedBarcode = selectedBarcodeId
      ? availableCodes.find((code) => code.id === selectedBarcodeId)
      : undefined;

    if (selectedBarcode) {
      setSelectedCodeId(selectedBarcode.id);
      return;
    }

    const fallbackQr = availableCodes.find((code) => code.type === "qr");
    const fallbackBarcode = availableCodes.find(
      (code) => code.type === "barcode"
    );
    setSelectedCodeId(fallbackQr?.id || fallbackBarcode?.id || "");
  }, [availableCodes, selectedBarcodeId, selectedCodeId]);

  const fileName = useMemo(() => {
    if (!selectedCode) return "";

    const prefix = `${slugify(item.name || item.type)}`;
    if (selectedCode.type === "qr") {
      return `${prefix}-${selectedCode.qrData?.size}-shelf-qr-code-${selectedCode.id}.png`;
    } else {
      return `${prefix}-${selectedCode.barcodeData?.type}-barcode-${selectedCode.barcodeData?.value}.png`;
    }
  }, [item, selectedCode]);

  function downloadCode(e: MouseEvent<HTMLButtonElement>) {
    const captureDiv = captureDivRef.current;
    const downloadBtn = downloadBtnRef.current;

    if (captureDiv && downloadBtn) {
      e.preventDefault();

      const options = {
        height: captureDiv.offsetHeight * 2,
        width: captureDiv.offsetWidth * 2,
        cacheBust: true,
        style: {
          transform: `scale(${2})`,
          transformOrigin: "top left",
          width: `${captureDiv.offsetWidth}px`,
          height: `${captureDiv.offsetHeight}px`,
        },
      };

      // Safari/iPad workaround: html-to-image needs to be called twice
      // First call "primes" the rendering, second call captures correctly
      waitForImagesToLoad(captureDiv)
        .then(() => toPng(captureDiv, options)) // First call (prime)
        .then(() => toPng(captureDiv, options)) // Second call (actual capture)
        .then((dataUrl: string) => {
          const downloadLink = document.createElement("a");
          downloadLink.href = changeDpiDataUrl(dataUrl, 300);
          downloadLink.download = fileName;
          downloadLink.click();
          URL.revokeObjectURL(downloadLink.href);
        })
        // eslint-disable-next-line no-console
        .catch(console.error);
    }
  }

  /**
   * QR codes print on a dedicated off-screen 2" x 1" layout so the output
   * matches standard label stock by default (see QR_PRINT_PAGE_STYLE).
   */
  const printQrLabel = useReactToPrint({
    contentRef: printLabelRef,
    pageStyle: QR_PRINT_PAGE_STYLE,
    onBeforePrint: () => {
      const container = printLabelRef.current;
      if (!container) return Promise.resolve();
      return waitForImagesToLoad(container);
    },
  });

  /** Barcodes keep printing the on-screen preview on the default page size. */
  const printBarcodeLabel = useReactToPrint({
    contentRef: captureDivRef,
    onBeforePrint: () => {
      const container = captureDivRef.current;
      if (!container) return Promise.resolve();
      return waitForImagesToLoad(container);
    },
  });

  function printCode() {
    if (selectedCode?.type === "qr") {
      printQrLabel();
    } else {
      printBarcodeLabel();
    }
  }

  // Don't render if no codes available
  if (availableCodes.length === 0) {
    return null;
  }

  return (
    <div
      className={tw("mb-4 w-auto rounded border bg-white", className)}
      style={style}
    >
      {/* Code Selector */}
      <div className="w-full border-b-[1.1px] border-[#E3E4E8] px-4 py-3">
        <div className="flex items-center justify-center gap-2">
          <select
            id="code-selector"
            aria-label="Select code to display"
            value={selectedCodeId}
            onChange={(e) => {
              setSelectedCodeId(e.target.value);
              const newSelectedCode = availableCodes.find(
                (code) => code.id === e.target.value
              );
              onCodeChange?.(newSelectedCode || null);
            }}
            className={tw(
              "min-w-0  flex-1 truncate rounded-md border border-gray-300 bg-white px-3 py-2 pr-7 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500",
              isBaseOrSelfService ? "max-w-[320px]" : "max-w-[280px]"
            )}
          >
            {availableCodes.map((code) => (
              <option key={code.id} value={code.id}>
                {code.label}
              </option>
            ))}
          </select>
          <When truthy={!isBaseOrSelfService}>
            <Button
              type="button"
              icon="plus"
              variant="secondary"
              size="sm"
              onClick={() => setIsAddBarcodeDialogOpen(true)}
              aria-label="Add code to asset"
              disabled={
                !canUseBarcodes
                  ? {
                      reason: isOwner ? (
                        <>
                          Your workspace doesn't have the barcodes addon
                          enabled.{" "}
                          <UnlockBarcodesModal
                            triggerVariant="link"
                            triggerLabel="Learn more"
                          />
                        </>
                      ) : (
                        <>
                          Your workspace doesn't currently support barcodes.
                          Contact your workspace owner to enable this feature,
                          or get in touch with{" "}
                          <CrispButton variant="link">sales</CrispButton>.
                        </>
                      ),
                    }
                  : false
              }
              tooltip={canUseBarcodes ? "Add code to asset" : undefined}
              className="shrink-0"
            />
          </When>
        </div>
      </div>

      {/* Code Preview */}
      <div className="flex w-full justify-center pt-6">
        {selectedCode?.type === "qr" ? (
          <QrLabel
            ref={captureDivRef}
            data={{ qr: { id: selectedCode.id, ...selectedCode.qrData } }}
            title={item.name}
            qrIdDisplayPreference={organization?.qrIdDisplayPreference}
            sequentialId={sequentialId}
            showShelfBranding={resolvedShowShelfBranding}
          />
        ) : selectedCode?.type === "barcode" ? (
          <BarcodeLabel
            ref={captureDivRef}
            data={selectedCode.barcodeData}
            title={item.name}
            showShelfBranding={resolvedShowShelfBranding}
          />
        ) : null}
      </div>

      {/* Off-screen 2" x 1" print layout for QR codes. react-to-print can't
          clone display:none content, so it's hidden via zero-height overflow. */}
      {selectedCode?.type === "qr" ? (
        <div style={{ overflow: "hidden", height: 0 }} aria-hidden="true">
          <QrLabelPrint
            ref={printLabelRef}
            data={{ qr: { id: selectedCode.id, ...selectedCode.qrData } }}
            title={item.name}
            qrIdDisplayPreference={organization?.qrIdDisplayPreference}
            sequentialId={sequentialId}
            showShelfBranding={resolvedShowShelfBranding}
          />
        </div>
      ) : null}

      {/* Actions */}
      <When truthy={!hideButton && !!selectedCode}>
        <div className="mt-8 flex w-full items-center gap-3 border-t-[1.1px] border-[#E3E4E8] px-4 py-3">
          <Button
            type="button"
            icon="download"
            onClick={downloadCode}
            download={fileName}
            ref={downloadBtnRef}
            variant="secondary"
            className="w-full"
          >
            Download
          </Button>
          <Button
            type="button"
            icon="print"
            variant="secondary"
            className="w-full"
            onClick={printCode}
          >
            Print
          </Button>
        </div>
      </When>

      {/* Add Barcode Dialog */}
      <AddBarcodeDialog
        isOpen={isAddBarcodeDialogOpen}
        onClose={() => setIsAddBarcodeDialogOpen(false)}
        item={item}
        onRefetchData={onRefetchData}
      />
    </div>
  );
};

// QR Label Component (existing)
export type QrDef = {
  id?: string;
  size?: SizeKeys;
  src?: string;
};

interface QrLabelProps {
  data?: { qr?: QrDef };
  title: string;
  qrIdDisplayPreference?: string;
  sequentialId?: string | null;
  showShelfBranding?: boolean;
}

export const QrLabel = React.forwardRef<HTMLDivElement, QrLabelProps>(
  function QrLabel(props, ref) {
    const {
      data,
      title,
      qrIdDisplayPreference,
      sequentialId,
      showShelfBranding = true,
    } = props ?? {};
    return (
      <div style={QR_LABEL_STYLE} ref={ref}>
        <div style={LABEL_TITLE_STYLE}>{title}</div>
        <figure className="qr-code flex justify-center">
          <img
            src={data?.qr?.src}
            alt={`${data?.qr?.size}-shelf-qr-code.png`}
          />
        </figure>
        <div className="w-full text-center text-[12px]">
          <div className="font-semibold">
            {resolveQrDisplayId(
              data?.qr?.id,
              qrIdDisplayPreference,
              sequentialId
            )}
          </div>
          {showShelfBranding ? (
            <div>
              Powered by{" "}
              <span className="font-semibold text-black">shelf.nu</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);

/**
 * Print-only QR label laid out for 2" x 1" label stock: QR code on the
 * left, title/ID/branding stacked on the right. Rendered off-screen by
 * `CodePreview` and passed to react-to-print together with
 * `QR_PRINT_PAGE_STYLE` so prints default to the physical label size.
 * The on-screen preview keeps using `QrLabel`.
 */
export const QrLabelPrint = React.forwardRef<HTMLDivElement, QrLabelProps>(
  function QrLabelPrint(props, ref) {
    const {
      data,
      title,
      qrIdDisplayPreference,
      sequentialId,
      showShelfBranding = true,
    } = props ?? {};
    return (
      <div style={QR_PRINT_LABEL_STYLE} ref={ref}>
        <img
          style={QR_PRINT_IMAGE_STYLE}
          src={data?.qr?.src}
          alt={`${data?.qr?.size}-shelf-qr-code.png`}
        />
        <div style={QR_PRINT_TEXT_COLUMN_STYLE}>
          <div style={QR_PRINT_TITLE_STYLE}>{title}</div>
          <div style={QR_PRINT_ID_STYLE}>
            {resolveQrDisplayId(
              data?.qr?.id,
              qrIdDisplayPreference,
              sequentialId
            )}
          </div>
          {showShelfBranding ? (
            <div style={QR_PRINT_BRANDING_STYLE}>
              Powered by <span style={{ fontWeight: 600 }}>shelf.nu</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);

// Barcode Label Component (new)
interface BarcodeLabelProps {
  data?: {
    type: BarcodeType;
    value: string;
  };
  title: string;
  showShelfBranding?: boolean;
}

export const BarcodeLabel = React.forwardRef<HTMLDivElement, BarcodeLabelProps>(
  function BarcodeLabel(props, ref) {
    const { data, title, showShelfBranding = true } = props ?? {};

    if (!data) return null;

    return (
      <div style={BARCODE_LABEL_STYLE} ref={ref}>
        <div style={LABEL_TITLE_STYLE}>{title}</div>
        <div className="flex flex-1 items-center justify-center">
          <BarcodeDisplay
            type={data.type}
            value={data.value}
            maxWidth="250px"
          />
        </div>
        <div className="w-full text-center text-[12px]">
          <div className="font-semibold">
            {data.type}:{" "}
            <div className="break-all leading-tight [overflow-wrap:break-word]">
              {data.type === "EAN13" ? (
                <Ean13LookupLink
                  value={data.value}
                  content={data.value}
                  className="text-[12px]"
                />
              ) : (
                data.value
              )}
            </div>
          </div>
          {showShelfBranding ? (
            <div>
              Powered by{" "}
              <span className="font-semibold text-black">shelf.nu</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);
