import type { ReactNode } from "react";
import { Providers } from "../../components/app/Providers";
import { Shell } from "../../components/app/Shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
