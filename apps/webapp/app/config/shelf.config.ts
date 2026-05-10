import {
  COLLECT_BUSINESS_INTEL,
  DISABLE_SIGNUP,
  DISABLE_SSO,
  ENABLE_PREMIUM_FEATURES,
  FREE_TRIAL_DAYS,
  GEOCODING_USER_AGENT,
  SEND_ONBOARDING_EMAIL,
  SHOW_HOW_DID_YOU_FIND_US,
} from "~/utils/env";
import { Config } from "./types";

export const config: Config = {
  // Fieldkit: onboarding email is hardcoded off. The upstream Shelf onboarding
  // copy is a founder note from Carlos Virreira that does not apply to Fieldkit.
  sendOnboardingEmail: false,
  enablePremiumFeatures: ENABLE_PREMIUM_FEATURES || false,
  freeTrialDays: Number(FREE_TRIAL_DAYS || 7),
  // Fieldkit: signup is hardcoded off. Users join only via admin invite.
  disableSignup: true,
  disableSSO: DISABLE_SSO || false,

  logoPath: {
    fullLogo: "/static/images/fieldkit-word-light.svg",
    symbol: "/static/images/fieldkit-symbol.png",
  },
  faviconPath: "/static/images/fieldkit-favicon.svg",
  emailPrimaryColor: "#00ac4e",
  showHowDidYouFindUs: SHOW_HOW_DID_YOU_FIND_US || false,
  collectBusinessIntel:
    COLLECT_BUSINESS_INTEL || SHOW_HOW_DID_YOU_FIND_US || false,
  geocoding: {
    userAgent: GEOCODING_USER_AGENT || "Self-hosted Asset Management System",
  },
};
