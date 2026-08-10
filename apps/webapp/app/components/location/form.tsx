import { useEffect } from "react";
import type { Location } from "@prisma/client";
import { useAtom, useAtomValue } from "jotai";
import { useActionData } from "react-router";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { updateDynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import { fileErrorAtom, defaultValidateFileAtom } from "~/atoms/file";
import { useAutoFocus } from "~/hooks/use-auto-focus";
import { useDisabled } from "~/hooks/use-disabled";
import useFetcherWithReset from "~/hooks/use-fetcher-with-reset";
import { centsToDollars, moneyDollarsSchema } from "~/modules/pricing/format";
import type { action as editLocationAction } from "~/routes/_layout+/locations.$locationId_.edit";
import type { action as newLocationAction } from "~/routes/_layout+/locations.new";
import { ACCEPT_SUPPORTED_IMAGES } from "~/utils/constants";
import { tw } from "~/utils/tw";
import { zodFieldIsRequired } from "~/utils/zod";
import { LocationSelect } from "./location-select";
import { Form } from "../custom-form";
import FormRow from "../forms/form-row";
import Input from "../forms/input";
import { RefererRedirectInput } from "../forms/referer-redirect-input";
import { AbsolutePositionedHeaderActions } from "../layout/header/absolute-positioned-header-actions";
import { Button } from "../shared/button";
import { ButtonGroup } from "../shared/button-group";
import { Card } from "../shared/card";
import { Spinner } from "../shared/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../shared/tooltip";
import When from "../when/when";

export const NewLocationFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string(),
  address: z.string(),
  parentId: z
    .string()
    .optional()
    .transform((value) => (value ? value : null)),

  /**
   * Storage classification. Blank means this is an organizational location —
   * a warehouse, a zone, a staging area — which never generates a storage
   * charge. Setting a tier makes it a billable position.
   */
  storageSlotTier: z
    .enum(["", "HALF_PALLET", "STANDARD_PALLET", "TALL_PALLET", "OVERSIZE"])
    .optional()
    .transform((value) => (value ? value : null)),

  /**
   * Maximum assets this location may hold. Blank means unlimited. A rack slot
   * should be 1 so a second pallet cannot be logged into an occupied
   * position — enforced by a database trigger, not just here.
   */
  capacity: z
    .string()
    .optional()
    .refine(
      (value) => {
        const trimmed = value?.trim();
        if (!trimmed) return true;
        const num = Number(trimmed);
        return Number.isInteger(num) && num >= 1;
      },
      {
        message:
          "Enter a whole number of 1 or more, or leave blank for no limit",
      }
    )
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? Number(trimmed) : null;
    }),

  /**
   * Per-month price for this specific position, in dollars. Overrides the
   * tier rate. Required for OVERSIZE, which has no standard rate.
   */
  storageMonthlyOverrideDollars: moneyDollarsSchema,
  addAnother: z
    .string()
    .optional()
    .transform((val) => val === "true"),
  preventRedirect: z.string().optional(),
  redirectTo: z.string().optional(),
});

type NewLocationPayload = Pick<Location, "id" | "name"> & {
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  parentId?: Location["parentId"];
};

interface Props {
  className?: string;
  name?: Location["name"];
  address?: Location["address"];
  description?: Location["description"];
  apiUrl?: string;
  /** Callback function to handle cancel action when form is used inline (e.g., in a dialog). When provided, Cancel button will call this instead of navigating. */
  onCancel?: () => void;
  /** Callback function triggered on successful location creation/update */
  onSuccess?: (data?: { location?: NewLocationPayload }) => void;
  parentId?: Location["parentId"];
  referer?: string | null;
  excludeLocationId?: Location["id"];
  /** Storage classification of this position. Null = not billable storage. */
  storageSlotTier?: Location["storageSlotTier"];
  /** Max assets this position may hold. Null = unlimited. */
  capacity?: Location["capacity"];
  /** Per-slot monthly price override, in cents. */
  storageMonthlyCentsOverride?: Location["storageMonthlyCentsOverride"];
}

// react-doctor:no-giant-component — deferred for follow-up refactor
export const LocationForm = ({
  className,
  name,
  address,
  description,
  apiUrl,
  onSuccess,
  parentId,
  referer,
  excludeLocationId,
  onCancel,
  storageSlotTier,
  capacity,
  storageMonthlyCentsOverride,
}: Props) => {
  const zo = useZorm("NewQuestionWizardScreen", NewLocationFormSchema);
  const fetcher = useFetcherWithReset<{
    success?: boolean;
    location?: NewLocationPayload;
    error?: { message?: string; additionalData?: { field?: string } };
    errors?: Record<string, { message?: string }>;
  }>();
  const fetcherData = fetcher.data;
  const hasOnSuccessFunc = typeof onSuccess === "function";
  const disabled = useDisabled(hasOnSuccessFunc ? fetcher : undefined);

  const actionData = useActionData<
    typeof newLocationAction | typeof editLocationAction
  >();
  const fileError = useAtomValue(fileErrorAtom);
  const [, validateFile] = useAtom(defaultValidateFileAtom);
  const [, updateName] = useAtom(updateDynamicTitleAtom);

  // Focus the name input on mount. Replaces `autoFocus` to satisfy
  // jsx-a11y/no-autofocus. When the form is rendered inside a dialog,
  // the dialog's `data-dialog-initial-focus` handler typically wins;
  // otherwise this provides the intentional initial focus.
  const nameInputRef = useAutoFocus<HTMLInputElement>();

  useEffect(() => {
    if (!hasOnSuccessFunc) return;

    if (fetcherData?.success) {
      onSuccess(fetcherData);
      fetcher.reset();
    }
  }, [fetcher, fetcherData, hasOnSuccessFunc, onSuccess]);

  const imageError =
    (hasOnSuccessFunc
      ? fetcherData?.errors?.image?.message ??
        (fetcherData?.error?.additionalData?.field === "image"
          ? fetcherData?.error?.message
          : undefined)
      : undefined) ??
    (actionData as any)?.errors?.image?.message ??
    ((actionData as any)?.error?.additionalData?.field === "image"
      ? (actionData as any)?.error?.message
      : undefined) ??
    fileError;

  const nameError =
    (hasOnSuccessFunc
      ? fetcherData?.error?.message || fetcherData?.errors?.name?.message
      : (actionData as any)?.error?.message ||
        (actionData as any)?.errors?.name?.message) ||
    zo.errors.name()?.message;

  const FormComponent = hasOnSuccessFunc ? fetcher.Form : Form;

  return (
    <Card
      className={tw(
        "w-full max-w-full md:w-min",
        hasOnSuccessFunc ? "border-none  shadow-none" : "",
        className
      )}
    >
      <FormComponent
        ref={zo.ref}
        method="post"
        className="flex w-full max-w-full flex-col gap-2"
        encType="multipart/form-data"
        action={apiUrl}
      >
        <RefererRedirectInput
          fieldName={zo.fields.redirectTo()}
          referer={referer}
        />

        {hasOnSuccessFunc ? null : (
          <AbsolutePositionedHeaderActions className="hidden md:flex">
            <Actions
              disabled={disabled}
              referer={referer}
              onCancel={onCancel}
            />
          </AbsolutePositionedHeaderActions>
        )}

        <When
          truthy={hasOnSuccessFunc}
          fallback={
            <FormRow
              rowLabel={"Name"}
              className="border-b-0 pb-[10px] pt-0"
              required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
            >
              <Input
                ref={nameInputRef}
                label="Name"
                hideLabel
                name={zo.fields.name()}
                disabled={disabled}
                error={nameError}
                data-dialog-initial-focus
                onChange={hasOnSuccessFunc ? undefined : updateName}
                className="w-full"
                defaultValue={name || undefined}
                placeholder="Storage room"
                required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
              />
            </FormRow>
          }
        >
          <Input
            ref={nameInputRef}
            label="Name"
            hideLabel
            name={zo.fields.name()}
            disabled={disabled}
            error={nameError}
            data-dialog-initial-focus
            onChange={hasOnSuccessFunc ? undefined : updateName}
            className="w-full"
            defaultValue={name || undefined}
            placeholder="Storage room"
            required={zodFieldIsRequired(NewLocationFormSchema.shape.name)}
          />
        </When>

        <FormRow
          rowLabel={"Parent location"}
          subHeading={
            <p>
              Optional. Nest this location under an existing one to build
              breadcrumbs.
            </p>
          }
        >
          <div className="mb-2 block lg:hidden">
            <div className="text-sm font-medium text-gray-700">
              Parent location
            </div>
            <p className="text-xs text-gray-600">
              Optional. Nest this location under an existing one to build
              breadcrumbs.
            </p>
          </div>
          <LocationSelect
            isBulk={false}
            className="w-full max-w-full"
            popoverZIndexClassName={hasOnSuccessFunc ? "z-[10000]" : undefined}
            hideExtraContent={hasOnSuccessFunc}
            fieldName={zo.fields.parentId()}
            placeholder="No parent"
            defaultValue={parentId ?? undefined}
            hideCurrentLocationInput
            excludeIds={excludeLocationId ? [excludeLocationId] : undefined}
          />
        </FormRow>

        <When
          truthy={hasOnSuccessFunc}
          fallback={
            <FormRow rowLabel={"Main image"}>
              <div>
                <p className="hidden lg:block">
                  Accepts PNG, JPG, JPEG, or WebP (max.4 MB)
                </p>
                <Input
                  disabled={disabled}
                  accept={ACCEPT_SUPPORTED_IMAGES}
                  name="image"
                  type="file"
                  onChange={validateFile}
                  label={"Main image"}
                  hideLabel
                  error={imageError}
                  className="mt-2"
                  inputClassName="border-0 shadow-none p-0 rounded-none"
                />
                <p className="mt-2 lg:hidden">
                  Accepts PNG, JPG, JPEG, or WebP (max.4 MB)
                </p>
              </div>
            </FormRow>
          }
        >
          <Input
            disabled={disabled}
            accept={ACCEPT_SUPPORTED_IMAGES}
            name="image"
            type="file"
            onChange={validateFile}
            label={"Main image"}
            error={imageError}
            className="mt-2"
            inputClassName="border-0 shadow-none p-0 rounded-none"
          />
          <p className="hidden lg:block">
            Accepts PNG, JPG, JPEG, or WebP (max.4 MB)
          </p>
        </When>

        <When
          truthy={hasOnSuccessFunc}
          fallback={
            <FormRow
              rowLabel={"Address"}
              subHeading={
                <p>
                  Will set location’s geo position to address. Make sure to add
                  an accurate address, to ensure the map location is as accurate
                  as possible
                </p>
              }
              className="pt-[10px]"
              required={zodFieldIsRequired(NewLocationFormSchema.shape.address)}
            >
              <Input
                label="Address"
                hideLabel
                name={zo.fields.address()}
                disabled={disabled}
                error={zo.errors.address()?.message}
                className="w-full"
                defaultValue={address || undefined}
                required={zodFieldIsRequired(
                  NewLocationFormSchema.shape.address
                )}
              />
            </FormRow>
          }
        >
          <Input
            label="Address"
            name={zo.fields.address()}
            disabled={disabled}
            error={zo.errors.address()?.message}
            className="w-full"
            defaultValue={address || undefined}
            required={zodFieldIsRequired(NewLocationFormSchema.shape.address)}
          />
        </When>

        <When
          truthy={hasOnSuccessFunc}
          fallback={
            <FormRow
              rowLabel="Description"
              subHeading={
                <p>
                  This is the initial object description. It will be shown on
                  the location page. You can always change it.
                </p>
              }
              required={zodFieldIsRequired(
                NewLocationFormSchema.shape.description
              )}
            >
              <Input
                inputType="textarea"
                label="Description"
                hideLabel
                name={zo.fields.description()}
                defaultValue={description || ""}
                placeholder="Add a description for your location."
                disabled={disabled}
                data-test-id="locationDescription"
                className="w-full"
                required={zodFieldIsRequired(
                  NewLocationFormSchema.shape.description
                )}
              />
            </FormRow>
          }
        >
          <Input
            inputType="textarea"
            label="Description"
            name={zo.fields.description()}
            defaultValue={description || ""}
            placeholder="Add a description for your location."
            disabled={disabled}
            data-test-id="locationDescription"
            className="w-full"
            required={zodFieldIsRequired(
              NewLocationFormSchema.shape.description
            )}
          />
        </When>

        {/*
          Storage billing. Only rendered on the full-page form — the inline
          dialog variant (hasOnSuccessFunc) is a quick-create used from asset
          screens, where slot classification would be noise.
        */}
        <When truthy={!hasOnSuccessFunc}>
          <FormRow
            rowLabel="Storage billing"
            subHeading={
              <p>
                Set a slot type to make this a billable pallet position. Leave
                it blank for warehouses, zones, and staging areas — those never
                generate a storage charge.
              </p>
            }
          >
            <div className="flex w-full flex-col gap-4">
              <div>
                <label
                  htmlFor="storageSlotTier"
                  className="mb-1 block text-[14px] font-medium text-gray-700"
                >
                  Slot type
                </label>
                <select
                  id="storageSlotTier"
                  name={zo.fields.storageSlotTier()}
                  disabled={disabled}
                  defaultValue={storageSlotTier ?? ""}
                  className="w-full rounded-md border border-gray-300 px-3.5 py-2.5 text-[16px] text-gray-900 focus:border-primary-300 focus:ring focus:ring-primary-100 md:text-[14px]"
                  aria-describedby="storageSlotTier-hint"
                >
                  <option value="">Not billable storage</option>
                  <option value="HALF_PALLET">
                    Half pallet — 48×40, under 2 ft
                  </option>
                  <option value="STANDARD_PALLET">
                    Standard pallet — 48×40, up to 4 ft
                  </option>
                  <option value="TALL_PALLET">
                    Tall pallet — 48×40, over 4 ft
                  </option>
                  <option value="OVERSIZE">
                    Oversize / custom footprint — priced per slot
                  </option>
                </select>
                <p
                  id="storageSlotTier-hint"
                  className="mt-1 text-xs text-gray-500"
                >
                  Pallet positions bill once per month however many items sit on
                  them. Oversize bills per item in the area.
                </p>
              </div>

              <div>
                <Input
                  label="Capacity"
                  type="number"
                  min="1"
                  step="1"
                  name={zo.fields.capacity()}
                  disabled={disabled}
                  defaultValue={capacity ?? ""}
                  placeholder="Leave blank for no limit"
                  error={zo.errors.capacity()?.message}
                  className="w-full"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Set 1 for a rack slot so a second pallet can&apos;t be logged
                  into it by mistake. Leave blank for floor areas.
                </p>
              </div>

              <div>
                <Input
                  label="Monthly price override ($)"
                  type="number"
                  min="0"
                  step="0.01"
                  name={zo.fields.storageMonthlyOverrideDollars()}
                  disabled={disabled}
                  defaultValue={centsToDollars(storageMonthlyCentsOverride)}
                  placeholder="Leave blank to use the standard rate"
                  error={zo.errors.storageMonthlyOverrideDollars()?.message}
                  className="w-full"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Overrides the tier rate for this position. Required for
                  oversize slots, which have no standard rate.
                </p>
              </div>
            </div>
          </FormRow>
        </When>

        {hasOnSuccessFunc ? (
          <input type="hidden" name="preventRedirect" value="true" />
        ) : null}

        <FormRow className="border-y-0 py-2" rowLabel="">
          <div className="ml-auto">
            <Button type="submit" disabled={disabled}>
              {disabled ? <Spinner /> : "Save"}
            </Button>
          </div>
        </FormRow>
      </FormComponent>
    </Card>
  );
};

const Actions = ({
  disabled,
  referer,
  onCancel,
}: {
  disabled: boolean;
  referer?: string | null;
  onCancel?: () => void;
}) => (
  <>
    <ButtonGroup>
      {/* When onCancel is provided (inline mode), use onClick instead of navigation */}
      {onCancel ? (
        <Button
          type="button"
          onClick={onCancel}
          variant="secondary"
          disabled={disabled}
        >
          Cancel
        </Button>
      ) : (
        <Button to={referer ?? ".."} variant="secondary" disabled={disabled}>
          Cancel
        </Button>
      )}
      <AddAnother disabled={disabled} />
    </ButtonGroup>

    <Button type="submit" disabled={disabled}>
      Save
    </Button>
  </>
);

const AddAnother = ({ disabled }: { disabled: boolean }) => (
  <TooltipProvider delayDuration={100}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled}
          name="addAnother"
          value="true"
        >
          Add another
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-sm">Save the location and add a new one</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
