"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

// Keeping the conversation at its newest line, in place of use-stick-to-bottom. That library ran a spring animation that
// read the scroll box's size every frame (hundreds of reads each time a side panel opened) and, on every wheel tick,
// walked up from the pointer asking each element for its computed style. This does the same job from the scroll, wheel
// and resize events the browser already sends, and measures only while it is actually gliding to the end.

/** How close to the end still counts as being there, for the "Go to the latest message" button. */
const NEAR_BOTTOM_PX = 70;

type StickContext = {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: () => void;
};
const Stick = createContext<StickContext | null>(null);
const useStick = () => {
  const ctx = useContext(Stick);
  if (!ctx) throw new Error("Conversation parts must be inside a Conversation");
  return ctx;
};

export type ConversationProps = ComponentProps<"div"> & {
  /** How it gets to the end when it first opens. */
  initial?: "smooth" | "instant";
  /** How it follows new content while it is at the end. */
  resize?: "smooth" | "instant";
  /**
   * Opens with this element (a selector inside the content) at the top instead of at the end: an agent's first unread
   * item, so catching up starts where the new part does. Read once, when it opens.
   */
  openAt?: string;
  /** Told whether the view is at the end (following new content) or someone has moved up to read, each time that changes. */
  onFollow?: (atBottom: boolean) => void;
};

export const Conversation = ({ className, initial = "smooth", resize = "smooth", openAt, onFollow, children, ...props }: ConversationProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Set by the effect below, which owns whether the view follows new content; the button's way back asks it to.
  const follow = useRef(() => {});
  const behaviour = useRef({ initial, resize });
  behaviour.current = { initial, resize };
  const anchorAt = useRef(openAt);
  const told = useRef(onFollow);
  told.current = onFollow;
  useEffect(() => told.current?.(isAtBottom), [isAtBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // Whether new content pulls the view down with it: on until the person moves up, on again once they are back at the end.
    let pinned = true;
    let lastTop = el.scrollTop;
    // The first moments after opening are still opening: code highlighting and pictures settle the height a few times, and
    // each of those is a jump to the end, not a glide, so a chat opens on its latest message without being seen to scroll there.
    const openedAt = Date.now();
    // A pointer held down in the feed is someone selecting text or dragging the scrollbar: following then would pull
    // the words out from under them.
    let held = false;
    // When the person last asked to move by keyboard or touch: the only scrolls up, besides the wheel and a held pointer, that
    // are theirs.
    let keyedAt = 0;
    // How tall the content was at the last scroll. The browser's own moves up (keeping the view anchored as something above
    // shrinks, or clamping it to a shorter page) come with the height changing; a wheel over a drawing's frame, which never
    // reaches this page, comes with it unchanged. The scroll can arrive before the resize is reported, so it is compared here.
    let lastHeight = el.scrollHeight;
    // Opening at a point (openAt): the feed draws in stages, a long one growing for a few frames, so the point is put back
    // at the top each time it grows while it opens, until the person moves the view themselves.
    let anchoring = !!anchorAt.current;
    let ownTop = -1;
    const place = (): boolean => {
      if (!anchoring) return false;
      if (Date.now() - openedAt > 1500) return (anchoring = false);
      const anchor = content.querySelector<HTMLElement>(anchorAt.current!);
      if (!anchor) return false;
      el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      lastTop = ownTop = el.scrollTop;
      // Short of the end only when it really is: what follows the point may all fit, and then the view follows as ever.
      pinned = gapOf() <= 1;
      setIsAtBottom(pinned);
      return true;
    };
    const gapOf = () => el.scrollHeight - el.clientHeight - el.scrollTop;
    // The glide down: a quarter of what is left each frame, and it stops the moment the view lets go. Not the browser's
    // smooth scrolling, which runs on to where it was sent and so swallowed a wheel turned up while it was going.
    let frame = 0;
    const glide = () => {
      frame = 0;
      if (!pinned || held) return;
      const gap = gapOf();
      if (gap <= 1) return;
      el.scrollTop += Math.ceil(gap / 4);
      frame = requestAnimationFrame(glide);
    };
    const toEnd = (how: "smooth" | "instant") => {
      if (how === "instant") el.scrollTop = el.scrollHeight;
      else frame ||= requestAnimationFrame(glide);
    };
    const onScroll = () => {
      const top = el.scrollTop;
      // The scroll that opening at a point made: near the end is not a reason to start following again. Any other is the
      // person's, and from then on the view is theirs.
      if (top === ownTop) return void (ownTop = -1);
      if (ownTop !== -1 || anchoring) anchoring = false;
      ownTop = -1;
      const gap = el.scrollHeight - el.clientHeight - top;
      // Moving up lets go only when the person moved it: the browser also moves the view up by itself when content above
      // shrinks (an older run folding to one line as a new one starts, a drawing settling its height), and taking that for
      // the person left the view short of a new answer.
      const height = el.scrollHeight;
      if (top < lastTop && gap > 1 && (held || Date.now() - keyedAt < 600 || height === lastHeight)) pinned = false;
      else if (gap <= NEAR_BOTTOM_PX) pinned = true;
      lastHeight = height;
      lastTop = top;
      setIsAtBottom(pinned || gap <= NEAR_BOTTOM_PX);
    };
    // A wheel turned up lets go at once: waiting for the scroll it causes loses it under the glide down to new words.
    // Checked only while following, so after the first tick a wheel costs nothing.
    const onWheel = (e: WheelEvent) => {
      anchoring = false;
      if (!pinned || e.deltaY >= 0) return;
      // A box inside that can still scroll up (a long tool output) takes the wheel itself, and the feed stays put.
      for (let n = e.target instanceof Element ? e.target : null; n && n !== el; n = n.parentElement) if (n.scrollTop > 0) return;
      pinned = false;
    };
    // The content growing (new words, a panel making the column narrower) and the box itself changing height both
    // leave a pinned view short of the end.
    const resized = new ResizeObserver(() => {
      if (place()) return;
      const gap = gapOf();
      if (pinned && !held && gap > 1) toEnd(Date.now() - openedAt < 600 ? behaviour.current.initial : behaviour.current.resize);
      setIsAtBottom(pinned || gap <= NEAR_BOTTOM_PX);
    });
    const press = () => (held = true);
    const release = () => (held = false);
    const keyed = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) keyedAt = Date.now();
    };
    const touched = () => (keyedAt = Date.now());
    follow.current = () => {
      pinned = true;
      setIsAtBottom(true);
      toEnd("smooth");
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", press);
    window.addEventListener("keydown", keyed);
    el.addEventListener("touchmove", touched, { passive: true });
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    resized.observe(content);
    resized.observe(el);
    // Opening at a point in the conversation: not following the end, with the way down to it offered.
    place();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("keydown", keyed);
      el.removeEventListener("touchmove", touched);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      resized.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <Stick.Provider value={{ scrollRef, contentRef, isAtBottom, scrollToBottom: () => follow.current() }}>
      <div className={cn("relative flex-1 overflow-y-hidden", className)} role="log" {...props}>
        {children}
      </div>
    </Stick.Provider>
  );
};

export type ConversationContentProps = ComponentProps<"div"> & { scrollClassName?: string };

export const ConversationContent = ({ className, scrollClassName, ...props }: ConversationContentProps) => {
  const { scrollRef, contentRef } = useStick();
  return (
    <div ref={scrollRef} className={scrollClassName} style={{ height: "100%", width: "100%", overflow: "auto", scrollbarGutter: "stable both-edges" }}>
      <div ref={contentRef} className={cn("flex flex-col gap-8 p-4", className)} {...props} />
    </div>
  );
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStick();

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full",
          className
        )}
        onClick={scrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        aria-label="Go to the latest message"
        title="Go to the latest message"
        {...props}
      >
        <ArrowDownIcon className="size-4" aria-hidden />
      </Button>
    )
  );
};
