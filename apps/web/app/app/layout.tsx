import type { ReactNode } from "react";
import { Providers } from "../../components/app/Providers";
import { Shell } from "../../components/app/Shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="appdark">
      <Providers>
        <Shell>{children}</Shell>
      </Providers>
    </div>
  );
}
