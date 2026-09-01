import { EvaluationMethods } from "../../components/evaluation-methods";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";

export default function EvalsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell">
        <EvaluationMethods mode="public" />
      </main>
      <SiteFooter />
    </>
  );
}
