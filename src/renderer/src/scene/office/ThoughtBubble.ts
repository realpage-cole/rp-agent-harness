import { Container, Graphics, Text } from 'pixi.js';
import { colors } from '@/design/tokens';
import { toolIcon } from './ToolBubble';

// A comic "thought cloud" pinned above an avatar's head showing what it's doing
// RIGHT NOW (the agent's live `action`, e.g. "edit App.tsx" / "bash npm test").
// Distinct from the darker ToolBubble speech bubble: a light cream cloud with a
// trailing-puff tail — the visual shorthand for "thinking". Built to DESIGN.md:
// integer pixels, hard 1px ink outline, limited palette, no soft shadows.
//
// Shares ToolBubble's fade state machine and text truncation so behaviour reads
// consistently; the differences are the look (cloud + tail, light fill) and that
// it stays put until the action changes (no auto-linger while the agent works).

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 5;
const MAX_WIDTH = 150;
const FILL_COLOR = colors.cream[50];   // light cloud
const OUTLINE_COLOR = colors.ink[900];
const TEXT_COLOR = '#3d2e4a';           // ink-700
const FONT_SIZE = 11;
const RENDER_SCALE = 0.5;               // render at 2x, scale down for crispness
const OFFSET_Y = -38;                   // a touch higher than the tool bubble
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 1.2;            // only used when hide() is requested
const DOTS_CYCLE_SPEED = 0.45;

type BubbleState = 'hidden' | 'fading-in' | 'visible' | 'lingering' | 'fading-out';

export class ThoughtBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private tail: Graphics;
  private label: Text;
  private state: BubbleState = 'hidden';
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  private isThinking = false;
  private dotsElapsed = 0;
  private dotsPhase = 0;
  // Extra upward shift (px) applied on top of OFFSET_Y so two nearby bubbles can
  // stack instead of overlapping. Set each frame by the scene's overlap pass.
  private extraLift = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100000;
    this.container.eventMode = 'none';
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.tail = new Graphics();
    this.bg = new Graphics();
    this.label = new Text({
      text: '',
      style: { fontSize: FONT_SIZE, fill: TEXT_COLOR, fontFamily: 'monospace' }
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    // tail first so it sits behind the body
    this.inner.addChild(this.tail, this.bg, this.label);
  }

  /** Show the current activity. Empty text → an animated "…" (model thinking).
   *  `tool` (an agent's `carrying`) prefixes a small glyph when present. */
  show(text: string, tool?: string): void {
    this.isThinking = !text.trim();
    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const display = tool ? `${toolIcon(tool)} ${text}` : text;
      this.label.text = display;
      const maxTextW = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
      let iterations = 0;
      let truncated = display;
      while (truncated.length > 3 && this.label.width > maxTextW && iterations++ < 60) {
        truncated = truncated.slice(0, -2) + '…';
        this.label.text = truncated;
      }
    }
    this.redraw();
    this.reveal();
  }

  private reveal(): void {
    if (this.state === 'hidden' || this.state === 'fading-out') {
      this.state = 'fading-in';
      this.fadeElapsed = 0;
      this.container.visible = true;
    } else {
      // already up — swap text in place without re-fading
      this.state = 'visible';
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  /** Begin fading out (after a short linger) — call when the agent goes quiet. */
  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  setPosition(px: number, py: number): void {
    const halfBubble = (this.bgW * RENDER_SCALE) / 2;
    this.container.x = Math.round(px - halfBubble);
    this.container.y = Math.round(py + OFFSET_Y - this.bgH * RENDER_SCALE - this.extraLift);
  }

  /** Extra upward shift (px), set by the scene's bubble-overlap pass. */
  setLift(px: number): void {
    this.extraLift = px;
  }

  /** The bubble's base screen rect (ignoring any lift) for a given anchor, or
   *  null when hidden. Used by the scene to detect and resolve overlaps. */
  getLayout(px: number, py: number): { x: number; y: number; w: number; h: number } | null {
    if (this.state === 'hidden') return null;
    const w = this.bgW * RENDER_SCALE;
    const h = this.bgH * RENDER_SCALE;
    return { x: px - w / 2, y: py + OFFSET_Y - h, w, h };
  }

  hide(): void {
    this.state = 'hidden';
    this.isThinking = false;
    this.container.alpha = 0;
    this.container.visible = false;
  }

  isHidden(): boolean {
    return this.state === 'hidden';
  }

  update(dt: number): void {
    if (this.isThinking && (this.state === 'visible' || this.state === 'fading-in')) {
      this.dotsElapsed += dt;
      const newPhase = Math.floor(this.dotsElapsed / DOTS_CYCLE_SPEED) % 3;
      if (newPhase !== this.dotsPhase) {
        this.dotsPhase = newPhase;
        this.label.text = ['.', '..', '...'][this.dotsPhase];
        this.redraw();
      }
    }

    switch (this.state) {
      case 'fading-in': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_IN_DURATION, 1);
        this.container.alpha = t;
        if (t >= 1) this.state = 'visible';
        break;
      }
      case 'lingering': {
        this.lingerElapsed += dt;
        if (this.lingerElapsed >= LINGER_DURATION) {
          this.state = 'fading-out';
          this.fadeElapsed = 0;
        }
        break;
      }
      case 'fading-out': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_OUT_DURATION, 1);
        this.container.alpha = 1 - t;
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redraw(): void {
    this.bgW = Math.min(this.label.width + PADDING_X * 2, MAX_WIDTH / RENDER_SCALE);
    this.bgH = this.label.height + PADDING_Y * 2;

    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: FILL_COLOR });
    this.bg.stroke({ color: OUTLINE_COLOR, width: 1 });

    // Thought-cloud tail: two shrinking puffs trailing down from the bubble's
    // lower-left toward the head below — the cue that says "thinking", not "speech".
    this.tail.clear();
    const baseX = this.bgW * 0.32;
    const puff = (cx: number, cy: number, r: number) => {
      this.tail.circle(cx, cy, r).fill({ color: FILL_COLOR }).stroke({ color: OUTLINE_COLOR, width: 1 });
    };
    puff(baseX, this.bgH + 4, 3);
    puff(baseX - 5, this.bgH + 9, 2);
  }
}
