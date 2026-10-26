/**
 * Whether one of somebody's own models can read pictures, guessed from its name until they say: OpenAI's, Anthropic's and Google's
 * current models, and the open vision models by the names they go by. A picture sent to a model that can't read one fails the
 * whole step, so a name that says nothing is guessed as no. Shared by the computer, which decides (runner/own-models.ts), and the
 * page, which shows the guess before the model is saved.
 */
const SEES = /gpt-4o|gpt-4\.1|gpt-5|gpt-6|\bo[34](?:-|$)|claude|gemini|gemma-?3|vision|[-_.]vl(?:[-_.:]|$)|llava|pixtral|qwen[\d.]*-?vl|llama-?(?:3\.2|4)|minicpm-v|moondream|grok-4/i;
export const seesByName = (model: string): boolean => SEES.test(model);
