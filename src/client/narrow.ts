/**
 * A window narrow enough that the chat list floats over the page instead of sitting beside it: the same width as
 * style.css's `@media (max-width: 1000px)`, which is also what 200% zoom makes of a 2000px screen.
 */
export const NARROW_PX = 1000;
export const isNarrow = (width: number): boolean => width <= NARROW_PX;
