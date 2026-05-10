import { Link, useMatches, Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import { ShelfSymbolLogo } from "~/components/marketing/logos";
import SubHeading from "~/components/shared/sub-heading";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

export const loader = () => null;

export const meta = () => [{ title: appendToMetaTitle("Authentication") }];

export default function App() {
  const matches = useMatches();
  /** Find the title and subHeading from current route */
  const data = matches[matches.length - 1].data as {
    title?: string;
    subHeading?: string;
  };
  const { title, subHeading } = data;

  return (
    <main className="flex h-screen">
      <div className="flex size-full flex-col items-center justify-center p-6 lg:p-10">
        <div className=" mb-8 text-center">
          <Link to="/" reloadDocument>
            <ShelfSymbolLogo />
          </Link>

          <h1>{title}</h1>
          {subHeading && (
            <SubHeading className="max-w-md">{subHeading}</SubHeading>
          )}
        </div>
        <div className=" w-[360px]">
          <Outlet />
        </div>
      </div>
      <aside className="relative hidden h-full flex-col items-end justify-end p-8 lg:flex lg:w-[700px] xl:w-[900px]">
        <img
          className="absolute inset-0 size-full max-w-none object-cover"
          src="/static/images/fieldkit-auth-cover.png"
          alt="Fieldkit"
        />
      </aside>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
