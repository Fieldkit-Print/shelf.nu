import { useCallback, useEffect, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { useFetcher } from "react-router";
import { useZorm } from "react-zorm";
import { useDisabled } from "~/hooks/use-disabled";
import { feedbackSchema } from "~/modules/feedback/schema";
import { getValidationErrors } from "~/utils/http";
import type { DataOrErrorResponse } from "~/utils/http.server";
import Input from "../forms/input";
import { Dialog, DialogPortal } from "../layout/dialog";
import { Button } from "../shared/button";

type FeedbackModalProps = {
  open: boolean;
  onClose: () => void;
};

export default function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const fetcher = useFetcher<DataOrErrorResponse>();
  const disabled = useDisabled(fetcher);
  const zo = useZorm("Feedback", feedbackSchema);
  const [showSuccess, setShowSuccess] = useState(false);

  const validationErrors = getValidationErrors<typeof feedbackSchema>(
    fetcher.data?.error
  );

  const generalError =
    fetcher.data?.error && !validationErrors
      ? fetcher.data.error.message
      : null;

  const handleClose = useCallback(() => {
    setShowSuccess(false);
    onClose();
  }, [onClose]);

  useEffect(
    function handleSuccess() {
      if (fetcher.data && !fetcher.data.error && fetcher.state === "idle") {
        setShowSuccess(true);
        const timer = setTimeout(handleClose, 2000);
        return () => clearTimeout(timer);
      }
    },
    [fetcher.data, fetcher.state, handleClose]
  );

  return (
    <DialogPortal>
      <Dialog
        open={open}
        onClose={handleClose}
        className="w-full sm:w-[440px]"
        headerClassName="border-b"
        title={
          <div className="-mb-3 w-full pb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Ask a question
            </h3>
            <p className="text-sm text-gray-600">
              Send us a question and we'll get back to you by email.
            </p>
          </div>
        }
      >
        {showSuccess ? (
          <div className="flex flex-col items-center justify-center px-6 py-12">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-green-100">
              <svg
                className="size-6 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-lg font-semibold text-gray-900">Thank you!</p>
            <p className="text-sm text-gray-600">
              Your question has been submitted.
            </p>
          </div>
        ) : (
          <fetcher.Form
            ref={zo.ref}
            method="POST"
            action="/api/feedback"
            className="flex flex-col"
          >
            <div className="space-y-4 px-6 py-4">
              {generalError ? (
                <div className="flex items-start gap-2 rounded-lg border border-error-300 bg-error-50 px-3 py-2 text-sm text-error-700">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <span>{generalError}</span>
                </div>
              ) : null}

              <Input
                inputType="textarea"
                label="Your question"
                name={zo.fields.message()}
                placeholder="What would you like to ask?"
                rows={5}
                maxLength={5000}
                required
                error={
                  validationErrors?.message?.message ||
                  zo.errors.message()?.message
                }
              />
            </div>

            <div className="flex items-center justify-end border-t px-6 py-4">
              <Button type="submit" disabled={disabled}>
                {disabled ? "Sending..." : "Send question"}
              </Button>
            </div>
          </fetcher.Form>
        )}
      </Dialog>
    </DialogPortal>
  );
}
