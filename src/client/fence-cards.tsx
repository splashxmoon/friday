import type { ReactNode } from "react";
import { SelfReviewCard } from "./SelfReviewCard.js";
import { BisectCard } from "./BisectCard.js";
import { BISECT_FENCE, readBisect } from "./bisect.js";
import { readReview, REVIEW_FENCE } from "./self-review.js";
import { RefactorDoneLine, RefactorPlanCard } from "./RefactorPlanCard.js";
import { DONE_FENCE, parseDone, parsePlan, PLAN_FENCE } from "./refactor-plan.js";
import { StackCard } from "./StackCard.js";
import { parseStack, STACK_FENCE } from "../stack-plan.js";

/**
 * The cards an agent's fenced report is drawn as: its self-review, the commit a bisect found, a refactor's plan and its closing
 * line, the split of a big change into a stack of pull requests. Loaded only when an answer has one of these blocks (AnswerParts.tsx), so a session screen's first load doesn't carry
 * them (test/client-bundle.test.ts). A block that doesn't read as its card is shown as it is (`plain`).
 */
export default function FenceCard({ fence, code, plain }: { fence: string; code: string; plain: ReactNode }) {
  if (fence === REVIEW_FENCE) {
    const review = readReview(code);
    return review ? <SelfReviewCard findings={review.findings} files={review.files} /> : plain;
  }
  if (fence === BISECT_FENCE) {
    const culprit = readBisect(code);
    return culprit ? <BisectCard culprit={culprit} /> : plain;
  }
  if (fence === PLAN_FENCE) {
    const plan = parsePlan(code);
    return plan ? <RefactorPlanCard plan={plan} /> : plain;
  }
  if (fence === DONE_FENCE) {
    const done = parseDone(code);
    return done ? <RefactorDoneLine done={done} /> : plain;
  }
  if (fence === STACK_FENCE) {
    const stack = parseStack(code);
    return stack ? <StackCard plan={stack} /> : plain;
  }
  return plain;
}
