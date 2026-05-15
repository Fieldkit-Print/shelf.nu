/**
 * Field Kit Storage — Marketing Landing Page
 *
 * This is the public-facing marketing landing page for Field Kit Storage,
 * a print production and logistics company that stores brand activation gear
 * (event kits, displays, BeMatrix systems, signage) for clients like Nike,
 * Hoka, and Puma.
 *
 * Behavior:
 * - loader: If the user is authenticated, redirect to /assets. Otherwise
 *   return null to render the landing page.
 * - action: Handles quote form POST submissions. Sends an internal
 *   notification email and an auto-reply to the lead.
 *
 * @see {@link file://./../../server/app.ts} — Hono server entry
 * @see {@link file://./../emails/mail.server.ts} — Email sending utility
 */

import { useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { sendEmail } from "~/emails/mail.server";
import { tw } from "~/utils/tw";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

/** SEO metadata for the landing page. */
export const meta = () => [
  { title: "Field Kit Storage — Activation Gear Storage" },
  {
    name: "description",
    content:
      "Per-pallet pricing, portal access on every item. Storage built for brand activations. Based in Caldwell, Idaho.",
  },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Redirects authenticated users to their asset dashboard.
 * Unauthenticated users see the marketing landing page.
 *
 * @param args - Remix loader function arguments including context
 * @returns null (render landing page) or a redirect to /assets
 */
export const loader = ({ context }: LoaderFunctionArgs) => {
  if (context.isAuthenticated) {
    return redirect("/assets");
  }
  return null;
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/** Shape returned by the quote form action. */
type QuoteActionData = { success: true } | { success: false; error: string };

/**
 * Handles the quote request form submission.
 *
 * Sends two emails on success:
 * 1. Internal notification to storage@fieldkit.cc
 * 2. Auto-reply confirmation to the lead
 *
 * @param args - Remix action function arguments
 * @returns QuoteActionData indicating success or failure
 */
export const action = async ({
  request,
}: ActionFunctionArgs): Promise<QuoteActionData> => {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "quote") {
    return { success: false, error: "Unknown form intent." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const pallets = String(formData.get("pallets") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!name || !email || !company) {
    return { success: false, error: "Name, email, and company are required." };
  }

  try {
    // Internal notification
    sendEmail({
      to: "storage@fieldkit.cc",
      subject: "New Storage Quote Request",
      text: [
        "A new storage quote request has been submitted.",
        "",
        `Name:          ${name}`,
        `Email:         ${email}`,
        `Company:       ${company}`,
        `Pallet count:  ${pallets || "Not specified"}`,
        `Notes:         ${notes || "None"}`,
      ].join("\n"),
    });

    // Auto-reply to lead
    sendEmail({
      to: email,
      subject: "We got your message — Field Kit Storage",
      text: [
        `Hi ${name},`,
        "",
        "Thanks for reaching out. We'll be in touch within 24 hours with a tailored quote.",
        "",
        "— The Field Kit Team",
      ].join("\n"),
    });

    return { success: true };
  } catch (_cause) {
    return {
      success: false,
      error: "Something went wrong sending your request. Please try again.",
    };
  }
};

// ---------------------------------------------------------------------------
// Default export — Landing Page
// ---------------------------------------------------------------------------

/**
 * The main landing page component for Field Kit Storage.
 *
 * Orchestrates the full marketing page layout and manages modal/calculator
 * state at the top level so child components can trigger the quote modal.
 */
export default function LandingPage() {
  const [isQuoteModalOpen, setIsQuoteModalOpen] = useState(false);
  const [prefilledPallets, setPrefilledPallets] = useState<number>(0);
  const actionData = useActionData<QuoteActionData>();

  const openQuote = (pallets = 0) => {
    setPrefilledPallets(pallets);
    setIsQuoteModalOpen(true);
  };

  // Close modal after successful submission
  const handleCloseModal = () => {
    setIsQuoteModalOpen(false);
  };

  return (
    <div className="min-h-screen bg-white font-sans">
      <StickyNav />
      <HeroSection onGetQuote={() => openQuote(0)} />
      <CustomersSection />
      <PricingSection onGetQuote={openQuote} />
      <WhatsIncludedSection />
      <HowItWorksSection />
      <WhyFieldKitSection />
      <FaqSection />
      <FinalCtaSection onGetQuote={() => openQuote(0)} />

      {isQuoteModalOpen && (
        <QuoteModal
          prefilledPallets={prefilledPallets}
          actionData={actionData}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sticky Nav
// ---------------------------------------------------------------------------

/**
 * Sticky top navigation bar with logo and sign-in link.
 */
function StickyNav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link to="/" aria-label="Field Kit — home">
          <img
            src="/static/images/fieldkit-word-light.svg"
            alt="Field Kit"
            className="h-8"
          />
        </Link>
        <Link
          to="/login"
          className="text-sm text-gray-600 transition-colors hover:text-primary"
        >
          Existing client? Sign in →
        </Link>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero Section
// ---------------------------------------------------------------------------

/** Props for the hero section. */
interface HeroSectionProps {
  /** Called when the user clicks "Get a quote". */
  onGetQuote: () => void;
}

/**
 * Full-width hero section with headline, subhead, and CTAs.
 * Desktop: 2-column grid (text left, photo right).
 * Mobile: stacked, photo below.
 */
function HeroSection({ onGetQuote }: HeroSectionProps) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
        {/* Text */}
        <div className="flex flex-col gap-6">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-gray-900 sm:text-5xl">
            Storage built for brand activations.
          </h1>
          <p className="text-lg leading-relaxed text-gray-600">
            Per-pallet pricing, portal access on every item, and the team that
            built your activation already on-site. Based in Caldwell, Idaho —
            west coast access without west coast rates.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={onGetQuote}
              className="rounded-lg bg-primary px-6 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Get a quote
            </button>
            <a
              href="https://calendar.fieldkit.cc"
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-medium text-gray-700 transition-colors hover:text-primary"
            >
              Talk to a human →
            </a>
          </div>
        </div>

        {/* Photo placeholder */}
        <div
          className="flex h-72 items-center justify-center rounded-xl bg-gray-100 lg:h-96"
          aria-hidden="true"
        >
          <span className="text-sm font-medium text-gray-400">
            Facility Photography
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Customers Section
// ---------------------------------------------------------------------------

/** Brand placeholder names for the logo row. */
const BRAND_NAMES = ["NIKE", "HOKA", "PUMA", "[Brand]", "[Brand]"] as const;

/**
 * Social proof section showing client brand logos (placeholder).
 */
function CustomersSection() {
  return (
    <section className="bg-gray-50 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <p className="mb-8 text-center text-lg font-semibold text-gray-700">
          Trusted by brands that move fast.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          {BRAND_NAMES.map((brand, i) => (
            <div
              key={i}
              className="flex h-10 w-32 items-center justify-center rounded border border-gray-200 bg-white"
              aria-label={`Client brand: ${brand}`}
            >
              <span className="text-xs font-bold tracking-widest text-gray-400">
                {brand}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-gray-500">
          Footwear, apparel, and beverage brands. Global activations to regional
          pop-ups. We handle the gear so they can focus on the moment.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pricing Section
// ---------------------------------------------------------------------------

/** Props for the pricing section. */
interface PricingSectionProps {
  /**
   * Called when the user clicks "Get a formal quote" from the calculator.
   * Receives the computed pallet total for pre-filling the quote modal.
   */
  onGetQuote: (pallets: number) => void;
}

/** Pricing card data structure. */
interface PricingTier {
  name: string;
  price: string;
  footprint: string;
  height: string;
  weight: string;
  popular: boolean;
}

/** Static pricing tier definitions. */
const PRICING_TIERS: PricingTier[] = [
  {
    name: "Half Pallet",
    price: "$30/mo",
    footprint: "24×40 or 48×20",
    height: 'Up to 48"',
    weight: "Up to 1,250 lbs",
    popular: false,
  },
  {
    name: "Standard Pallet",
    price: "$50/mo",
    footprint: "48×40 standard",
    height: 'Up to 60"',
    weight: "Up to 2,500 lbs",
    popular: true,
  },
  {
    name: "Oversize Pallet",
    price: "$80/mo",
    footprint: 'Over 60" tall or oversize footprint',
    height: "Custom",
    weight: "Ground-floor slot",
    popular: false,
  },
];

/** Activity rate line item. */
interface ActivityRate {
  label: string;
  rate: string;
}

/** Static activity rate definitions. */
const ACTIVITY_RATES: ActivityRate[] = [
  { label: "Inbound receipt", rate: "$10 per pallet" },
  { label: "Outbound pull", rate: "$10 per pallet" },
  { label: "Rush pull (same/next-day)", rate: "$200 flat per request" },
  { label: "Handling labor", rate: "$95/hr (15-min increments)" },
];

/**
 * Full pricing section including tier cards, activity rates table,
 * and an interactive cost calculator widget.
 */
function PricingSection({ onGetQuote }: PricingSectionProps) {
  // Calculator state
  const [stdPallets, setStdPallets] = useState(0);
  const [halfPallets, setHalfPallets] = useState(0);
  const [oversizePallets, setOversizePallets] = useState(0);
  const [inbound, setInbound] = useState(0);
  const [outbound, setOutbound] = useState(0);

  const storageCost = stdPallets * 50 + halfPallets * 30 + oversizePallets * 80;
  const activityCost = inbound * 10 + outbound * 10;
  const totalCost = storageCost + activityCost;

  const handleGetFormalQuote = () => {
    onGetQuote(stdPallets + halfPallets + oversizePallets);
  };

  return (
    <section className="py-16" id="pricing">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="mb-10 text-center text-3xl font-bold text-gray-900">
          Simple, transparent pricing.
        </h2>

        {/* Pricing cards */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {PRICING_TIERS.map((tier) => (
            <div
              key={tier.name}
              className={tw(
                "relative flex flex-col gap-4 rounded-xl border bg-white p-6 shadow-sm",
                tier.popular ? "border-primary" : "border-gray-200"
              )}
            >
              {tier.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-semibold text-white">
                  Most popular
                </span>
              )}
              <div>
                <p className="text-sm font-medium text-gray-500">{tier.name}</p>
                <p className="mt-1 text-3xl font-bold text-gray-900">
                  {tier.price}
                </p>
              </div>
              <ul className="flex flex-col gap-2 text-sm text-gray-600">
                <li>
                  <span className="font-medium text-gray-700">Footprint:</span>{" "}
                  {tier.footprint}
                </li>
                <li>
                  <span className="font-medium text-gray-700">Height:</span>{" "}
                  {tier.height}
                </li>
                <li>
                  <span className="font-medium text-gray-700">Weight:</span>{" "}
                  {tier.weight}
                </li>
              </ul>
            </div>
          ))}
        </div>

        {/* Activity rates */}
        <div className="mt-12 rounded-xl bg-gray-50 p-6">
          <h3 className="mb-4 text-base font-semibold text-gray-900">
            Activity rates
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ACTIVITY_RATES.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3"
              >
                <span className="text-sm text-gray-600">{item.label}</span>
                <span className="text-sm font-semibold text-gray-900">
                  {item.rate}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Cost calculator */}
        <div className="mt-10 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-1 text-lg font-semibold text-gray-900">
            Estimate your monthly cost
          </h3>
          <p className="mb-6 text-sm text-gray-500">
            Adjust the values below to see a live estimate.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <CalcInput
              label="Standard pallets"
              value={stdPallets}
              onChange={setStdPallets}
            />
            <CalcInput
              label="Half pallets"
              value={halfPallets}
              onChange={setHalfPallets}
            />
            <CalcInput
              label="Oversize pallets"
              value={oversizePallets}
              onChange={setOversizePallets}
            />
            <CalcInput
              label="Monthly inbound (pallets)"
              value={inbound}
              onChange={setInbound}
            />
            <CalcInput
              label="Monthly outbound (pallets)"
              value={outbound}
              onChange={setOutbound}
            />
          </div>

          {/* Totals */}
          <div className="mt-6 rounded-lg bg-gray-50 p-4">
            <div className="flex items-center justify-between py-1 text-sm text-gray-600">
              <span>Storage</span>
              <span>${storageCost.toLocaleString()}/mo</span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm text-gray-600">
              <span>Activity</span>
              <span>${activityCost.toLocaleString()}/mo</span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2">
              <span className="text-base font-semibold text-gray-900">
                Total
              </span>
              <span className="text-base font-bold text-primary">
                ${totalCost.toLocaleString()}/mo
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleGetFormalQuote}
            className="mt-4 w-full rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Get a formal quote
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Calculator Input Helper
// ---------------------------------------------------------------------------

/** Props for a single calculator number input. */
interface CalcInputProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
}

/**
 * A labeled number input used in the cost calculator widget.
 */
function CalcInput({ label, value, onChange }: CalcInputProps) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// What's Included Section
// ---------------------------------------------------------------------------

/** A single feature block for the "What's included" section. */
interface Feature {
  headline: string;
  description: string;
}

/** Static list of included features. */
const FEATURES: Feature[] = [
  {
    headline: "Portal access",
    description:
      "Real-time inventory visibility, pull requests, condition photos",
  },
  {
    headline: "Quarterly audit",
    description: "Physical walk-through with photo reconciliation",
  },
  {
    headline: "Photo documentation",
    description: "Every item logged on intake",
  },
  {
    headline: "Declared value insurance",
    description: "Coverage included up to declared value, riders available",
  },
  {
    headline: "Climate-controlled facility",
    description: "Stable temperature and humidity, dry storage",
  },
  {
    headline: "Same-day rush available",
    description: "Most regional markets, $200 surcharge",
  },
];

/**
 * Section listing all features included with every storage plan.
 */
function WhatsIncludedSection() {
  return (
    <section className="bg-gray-50 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="mb-10 text-center text-3xl font-bold text-gray-900">
          Everything you need. Nothing you don't.
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feat) => (
            <div
              key={feat.headline}
              className="flex flex-col gap-1 border-l-4 border-primary bg-white py-4 pl-5 pr-4"
            >
              <p className="text-sm font-semibold text-gray-900">
                {feat.headline}
              </p>
              <p className="text-sm text-gray-500">{feat.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How It Works Section
// ---------------------------------------------------------------------------

/** A single step in the onboarding process. */
interface Step {
  number: number;
  headline: string;
  description: string;
}

/** Static list of onboarding steps. */
const STEPS: Step[] = [
  {
    number: 1,
    headline: "Tell us what you've got.",
    description:
      "Fill out a quick form with rough pallet counts and item types. We'll quote within 24 hours.",
  },
  {
    number: 2,
    headline: "Sign and schedule.",
    description: "Simple MSA, first invoice, and inbound coordination.",
  },
  {
    number: 3,
    headline: "Ship it in.",
    description:
      "You handle freight (or we can quote it). We receive, photograph, slot, and confirm.",
  },
  {
    number: 4,
    headline: "Manage from anywhere.",
    description:
      "Request pulls, view inventory, see condition reports — all in the portal.",
  },
];

/**
 * Section walking prospects through the 4-step onboarding process.
 * Horizontal row with connecting line on desktop, vertical stack on mobile.
 */
function HowItWorksSection() {
  return (
    <section className="py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="mb-12 text-center text-3xl font-bold text-gray-900">
          Up and running in days, not weeks.
        </h2>
        <div className="relative">
          {/* Connecting line — desktop only */}
          <div
            className="absolute inset-x-0 top-6 hidden h-px bg-gray-200 lg:block"
            aria-hidden="true"
          />
          <ol className="relative z-10 grid grid-cols-1 gap-8 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.number} className="flex flex-col gap-3">
                <span className="flex size-12 items-center justify-center rounded-full bg-white text-xl font-bold text-primary ring-2 ring-primary">
                  {step.number}
                </span>
                <p className="text-base font-semibold text-gray-900">
                  {step.headline}
                </p>
                <p className="text-sm leading-relaxed text-gray-500">
                  {step.description}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Why Field Kit Section
// ---------------------------------------------------------------------------

/** A single value proposition block. */
interface ValueProp {
  headline: string;
  body: string;
}

/** Static value proposition copy. */
const VALUE_PROPS: ValueProp[] = [
  {
    headline: "Built for activations, not consumer goods.",
    body: "We started building event environments for global footwear and apparel brands. We know how a BeMatrix system breaks down, why a crated display needs ground-floor access, and what happens when refurb gets skipped between events. Generic 3PLs treat your gear like SKUs. We treat it like the kit it actually is.",
  },
  {
    headline: "One shop, one phone call.",
    body: "Storage, fabrication, print production, and project management under one roof. Your activation supply chain runs through one team. No vendor stack to manage, no handoffs between providers when something needs to ship Friday.",
  },
  {
    headline: "West coast access, mountain west costs.",
    body: "Caldwell, Idaho — one-day ground freight to Seattle, Portland, San Francisco, Salt Lake, and Denver. Premium service without premium real estate.",
  },
];

/** Trust strip stat/badge. */
const TRUST_ITEMS = [
  "8,000 sqft fabrication + storage space, Caldwell, ID",
  "Declared value coverage included",
  "Storage · Print · Fabrication · Creative · Project Management",
] as const;

/**
 * Section presenting Field Kit's key differentiators and a trust strip.
 */
function WhyFieldKitSection() {
  return (
    <section className="bg-gray-50 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="mb-10 text-center text-3xl font-bold text-gray-900">
          Why teams choose Field Kit.
        </h2>
        <div className="flex flex-col gap-8">
          {VALUE_PROPS.map((vp) => (
            <div key={vp.headline} className="flex flex-col gap-2">
              <h3 className="text-lg font-semibold text-gray-900">
                {vp.headline}
              </h3>
              <p className="max-w-3xl text-base leading-relaxed text-gray-600">
                {vp.body}
              </p>
            </div>
          ))}
        </div>

        {/* Trust strip */}
        <div className="mt-12 rounded-xl bg-white px-6 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
            {TRUST_ITEMS.map((item) => (
              <span key={item} className="text-sm font-medium text-gray-600">
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FAQ Section
// ---------------------------------------------------------------------------

/** A single FAQ entry. */
interface FaqItem {
  question: string;
  answer: string;
}

/** Static FAQ data. */
const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What's included in the monthly storage rate?",
    answer:
      "Portal access, quarterly audit, intake photos, declared value insurance coverage, and climate-controlled storage. Activity (receipts, pulls, handling) bills separately at standard rates.",
  },
  {
    question: "How does insurance work?",
    answer:
      "We carry blanket coverage up to a declared value per client. For higher-value inventory, we add an excess rider at carrier cost plus admin.",
  },
  {
    question: "What's the minimum term?",
    answer:
      "Month-to-month with 30-day notice. 6-month commits get 5% off. 12-month commits get 10% off with a 10-pallet minimum.",
  },
  {
    question: "What if I need something shipped same-day?",
    answer:
      "Available across most regional markets at a $200 rush fee per request. Submit by 12pm MT for same-day; by 4pm for next-day.",
  },
  {
    question: "How do I get my stuff to you?",
    answer:
      "You arrange inbound freight, or we quote it for you. We receive Monday–Friday, 8am–4pm. Saturday inbound by arrangement.",
  },
  {
    question: "What happens if items are damaged?",
    answer:
      "We document condition on intake. Damage discovered during pulls is photographed and reported within 24 hours. Insurance claims processed against declared value.",
  },
  {
    question: "Can you handle non-palletized items?",
    answer:
      "Small cartons and loose items bill as one pallet equivalent for activity. We'll consolidate onto a pallet at intake if it makes sense.",
  },
  {
    question: "Do you do production and fabrication too?",
    answer:
      "Yes — Field Kit also handles print, fabrication, and creative for activations. Storage clients often consolidate their full activation supply chain with us.",
  },
  {
    question: "What if I need to leave?",
    answer:
      "30 days notice for month-to-month, or per-term for commits. You have 30 days post-termination to retrieve inventory.",
  },
];

/**
 * FAQ section using Radix Collapsible for accessible accordion behavior.
 * Each item can be independently opened or closed.
 */
function FaqSection() {
  const [openItems, setOpenItems] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <section className="py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <h2 className="mb-10 text-center text-3xl font-bold text-gray-900">
          Common questions.
        </h2>
        <div className="flex flex-col divide-y divide-gray-200">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = openItems.has(i);
            return (
              <Collapsible.Root
                key={i}
                open={isOpen}
                onOpenChange={() => toggle(i)}
              >
                <Collapsible.Trigger
                  className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm font-medium text-gray-900 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-expanded={isOpen}
                >
                  <span>{item.question}</span>
                  <span
                    className="shrink-0 text-lg font-light text-gray-400"
                    aria-hidden="true"
                  >
                    {isOpen ? "−" : "+"}
                  </span>
                </Collapsible.Trigger>
                <Collapsible.Content className="pb-4 text-sm leading-relaxed text-gray-500">
                  {item.answer}
                </Collapsible.Content>
              </Collapsible.Root>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Final CTA Section
// ---------------------------------------------------------------------------

/** Props for the final CTA section. */
interface FinalCtaSectionProps {
  /** Called when the user clicks "Get a quote". */
  onGetQuote: () => void;
}

/**
 * Dark full-width CTA section at the bottom of the page.
 */
function FinalCtaSection({ onGetQuote }: FinalCtaSectionProps) {
  return (
    <section className="bg-gray-900 py-20">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 text-center sm:px-6">
        <h2 className="text-4xl font-bold text-white">Ready to consolidate?</h2>
        <p className="text-lg text-gray-300">
          Get a quote in 24 hours. No commitment, no pressure.
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onGetQuote}
            className="rounded-lg bg-primary px-8 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Get a quote
          </button>
          <a
            href="https://calendar.fieldkit.cc"
            target="_blank"
            rel="noopener noreferrer"
            className="text-base font-medium text-gray-300 transition-colors hover:text-white"
          >
            Talk to a human →
          </a>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quote Modal
// ---------------------------------------------------------------------------

/** Props for the quote modal. */
interface QuoteModalProps {
  /** Pre-filled pallet count from the calculator (0 = leave empty). */
  prefilledPallets: number;
  /** Action data from the last form submission. */
  actionData: QuoteActionData | undefined;
  /** Called when the modal should be closed. */
  onClose: () => void;
}

/**
 * Accessible quote request modal rendered as a full-screen overlay.
 *
 * Uses a Remix Form (method="POST") with a hidden `intent="quote"` field.
 * Shows a success state after a successful submission.
 */
function QuoteModal({
  prefilledPallets,
  actionData,
  onClose,
}: QuoteModalProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const isSuccess = actionData?.success === true;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Get a storage quote"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal card */}
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl sm:p-8">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Close modal"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {isSuccess ? (
          /* Success state */
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-primary"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-gray-900">
              Got it. We'll be in touch within 24 hours.
            </p>
            <p className="text-sm text-gray-500">
              Check your inbox for a confirmation email.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Close
            </button>
          </div>
        ) : (
          /* Form state */
          <>
            <h2 className="mb-1 text-xl font-bold text-gray-900">
              Get a storage quote
            </h2>
            <p className="mb-6 text-sm text-gray-500">
              We'll respond within 24 hours with a tailored quote.
            </p>

            {actionData?.success === false && (
              <p
                role="alert"
                className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {actionData.error}
              </p>
            )}

            <Form method="POST" className="flex flex-col gap-4">
              <input type="hidden" name="intent" value="quote" />

              <FormField
                label="Name"
                name="name"
                type="text"
                required
                autoComplete="name"
              />
              <FormField
                label="Work email"
                name="email"
                type="email"
                required
                autoComplete="email"
              />
              <FormField
                label="Company"
                name="company"
                type="text"
                required
                autoComplete="organization"
              />
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="pallets"
                  className="text-sm font-medium text-gray-700"
                >
                  Rough pallet count{" "}
                  <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  id="pallets"
                  name="pallets"
                  type="number"
                  min={0}
                  defaultValue={
                    prefilledPallets > 0 ? prefilledPallets : undefined
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="notes"
                  className="text-sm font-medium text-gray-700"
                >
                  Tell us about your stuff{" "}
                  <span className="text-gray-400">(optional)</span>
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={3}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                  placeholder="Event kits, display hardware, BeMatrix systems, etc."
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 w-full rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Sending..." : "Send quote request"}
              </button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormField helper
// ---------------------------------------------------------------------------

/** Props for the reusable FormField input component inside the quote modal. */
interface FormFieldProps {
  label: string;
  name: string;
  type: string;
  required?: boolean;
  autoComplete?: string;
}

/**
 * A simple labeled text/email input for use inside the quote modal form.
 */
function FormField({
  label,
  name,
  type,
  required,
  autoComplete,
}: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </div>
  );
}
