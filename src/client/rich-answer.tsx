import { MessageResponse } from "@/components/ai-elements/message";
import { ANSWER, mediaText } from "./AnswerParts.js";

/** An agent's words drawn as an answer is (AnswerParts.tsx): loaded on demand by lazy-answer.tsx, never with the app. */
export default function RichAnswer({ text }: { text: string }) {
  return <MessageResponse {...ANSWER}>{mediaText(text)}</MessageResponse>;
}
