/* eslint-disable no-console */
import * as Sentry from "@sentry/react-router";
import { type Event, type EventHint } from "@sentry/react-router";

import { SENTRY_DSN } from "~/utils/env";
import { isAbortError, isLikeShelfError, ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

/**
 * Process-level safety net for errors that escape every request-scoped
 * handler: rejected promises from detached async work (timers, queue
 * side-effects) and synchronous throws outside a request. Node's default
 * for both is to terminate the process — which is exactly how the pg-boss
 * "Connection terminated unexpectedly" incident took production down on
 * 2026-07-10. Sentry's handleError only covers loaders/actions/render,
 * so without these hooks any background rejection is fatal.
 *
 * We log-and-survive rather than exit: the platform (Render) restarts on
 * a real crash anyway, so exiting here would only drop in-flight requests
 * for error classes that are almost always recoverable (dropped DB
 * connections, email render failures). The guard keeps HMR in dev from
 * stacking duplicate listeners.
 */
declare global {
  var __processErrorHandlersInstalled: boolean | undefined;
}
if (!global.__processErrorHandlersInstalled) {
  global.__processErrorHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    try {
      Logger.error(
        new ShelfError({
          cause: reason,
          message:
            "Unhandled promise rejection reached the process level. The error escaped all request/worker handlers — find and fix the missing catch.",
          label: "Scheduler",
        })
      );
    } catch {
      // Never let the safety net itself crash the process.
      // eslint-disable-next-line no-console
      console.error("unhandledRejection (logger failed):", reason);
    }
  });

  process.on("uncaughtException", (error) => {
    try {
      Logger.error(
        new ShelfError({
          cause: error,
          message:
            "Uncaught exception reached the process level. The process is kept alive, but state may be inconsistent — investigate promptly.",
          label: "Scheduler",
        })
      );
    } catch {
      // eslint-disable-next-line no-console
      console.error("uncaughtException (logger failed):", error);
    }
  });
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Performance Monitoring
    tracesSampleRate: 0.1,
    beforeBreadcrumb(breadcrumb) {
      // Remove some noisy breadcrumbs
      if (
        breadcrumb.message?.startsWith("🚀") ||
        breadcrumb.message?.startsWith("🌍")
      ) {
        return null;
      }

      if (breadcrumb.message) {
        // Remove chalk colors that pollute the logs
        breadcrumb.message = breadcrumb.message.replace(
          // eslint-disable-next-line no-control-regex -- let me do my thing
          /(\x1B\[32m|\x1B\[0m)/gm,
          ""
        );
      }

      return breadcrumb;
    },
    beforeSendTransaction(event, hint) {
      return handleBeforeSend(event, hint);
    },
    beforeSend(event, hint) {
      return handleBeforeSend(event, hint);
    },
  });

  // Sentry example
  if (process.env.NODE_ENV === "production") {
    console.log("Sentry is enabled");
    console.log("Doing some Sentry stuff before the server starts");
  }
}

/**
 * Filter out non 5xx errors to avoid spamming and log only the necessary.
 */
function handleBeforeSend<E extends Event>(event: E, hint: EventHint) {
  const exception = hint.originalException;

  if (
    !(exception instanceof Error) ||
    (isLikeShelfError(exception) && !exception.shouldBeCaptured)
  ) {
    return null;
  }

  // Drop aborted-request errors that bypass `makeShelfError` — usually thrown
  // raw from streaming handlers or middleware when a client disconnects.
  if (isAbortError(exception)) {
    return null;
  }

  /** Hide the __authSession cookie */
  if (event.request?.cookies) {
    event.request.cookies["__authSession"] = "hidden";
  }

  return {
    ...event,
    ...makeSentryContext(exception),
  };
}

/**
 * Make the Sentry context from our ShelfError
 */
function makeSentryContext(event: unknown | null | undefined) {
  if (!event) {
    return;
  }

  const maybeShelfError = event as Partial<ShelfError>;

  return {
    user: {
      id: (maybeShelfError.additionalData?.userId as string) || "?",
    },
    tags: {
      label: maybeShelfError.label || "Unknown",
      shelf_trace_id: maybeShelfError.traceId || "Unknown",
    },
    extra: {
      ...(maybeShelfError.additionalData || {}),
      traceId: maybeShelfError.traceId,
      message: maybeShelfError.message,
      cause: {
        message: (maybeShelfError.cause as Error | null)?.message,
        raw: JSON.stringify(maybeShelfError.cause),
      },
    },
  };
}
