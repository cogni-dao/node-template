// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/content`
 * Purpose: Single customization surface for the public landing page. ALL editable
 *   copy and placeholder data for the homepage lives here — hero, showcase cards,
 *   activity feed, and stats. The components in `./components/*` are layout only;
 *   they read everything from this file.
 * Scope: Public homepage content. No logic, no IO — pure data.
 * Invariants: Shapes are stable so layout components stay generic. Customize VALUES,
 *   not shapes, when minting a new node.
 * Side-effects: none
 * Links: src/features/home/components/LandingHero.tsx,
 *   src/features/home/components/ShowcaseCards.tsx,
 *   src/features/home/components/ActivityFeed.tsx,
 *   src/features/home/components/AgentStream.tsx,
 *   src/features/home/components/HomeStats.tsx
 * @public
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ███  CUSTOMIZE YOUR NODE HERE  ███
 *
 *  This file is the homepage. To make the landing page yours, you edit WORDS in
 *  this file and the brand HUE in `src/styles/tailwind.css`. You should not need
 *  to touch the layout components for a first-class customization.
 *
 *  Walk top-to-bottom and replace every placeholder with copy + data that sells
 *  YOUR node's mission. A stranger should understand what this node is for in
 *  five seconds. See `docs/guides/new-node-styling.md` and the `node-styling`
 *  skill for the full playbook.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Activity,
  BrainCircuit,
  CheckCircle,
  Network,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/* ─── HERO ────────────────────────────────────────────────────────────────
 * The first thing a visitor sees. `headline` renders as two lines; the second
 * line gets the brand gradient. Keep it short and declarative.
 */
export interface HeroContent {
  /** Tiny uppercase label inside the status pill at the top of the hero. */
  statusLabel: string;
  /** Line 1 of the headline (plain foreground color). */
  headlineTop: string;
  /** Line 2 of the headline (renders with the brand gradient). */
  headlineAccent: string;
  /** One- to two-sentence value prop under the headline. */
  subhead: string;
  /** Primary CTA — wired to the "try the demo" sign-in flow. */
  primaryCta: string;
  /** Small uppercase tagline shown next to the primary CTA. */
  ctaTagline: string;
}

export const HERO: HeroContent = {
  statusLabel: "Template online",
  headlineTop: "Choose a niche.",
  headlineAccent: "Launch its AI node.",
  subhead:
    "Spawn this template, give the node a mission, and set an AI to work in public. Contributors earn governance tokens, then vote on the agent's roadmap, priorities, and budget.",
  primaryCta: "Try the template",
  ctaTagline: "Pick the mission. Train the agent. Govern the budget.",
};

/* ─── HERO LINKS ──────────────────────────────────────────────────────────
 * Secondary buttons in the hero. Point them at your community + source.
 */
export const HERO_LINKS = {
  chatUrl: "https://discord.gg/3b9sSyhZ4z",
  sourceUrl: "https://github.com/cogni-dao/cogni",
} as const;

/* ─── AGENT STREAM ────────────────────────────────────────────────────────
 * The live "console" embedded in the hero. Each sequence plays out like the
 * agent thinking in real time, then loops to the next. Rewrite these lines to
 * describe what YOUR agent actually does, step by step. Keep ~4-6 events each.
 */
export type StreamEventType =
  | "thinking"
  | "searching"
  | "analyzing"
  | "signal"
  | "done";

export interface StreamEvent {
  id: string;
  type: StreamEventType;
  text: string;
  /** ms offset from the start of the sequence when this line appears. */
  at: number;
}

/** Label shown in the stream header next to the spinner. */
export const AGENT_STREAM_SUBJECT = "cogni/node";

export const AGENT_STREAM_SEQUENCES: StreamEvent[][] = [
  [
    {
      id: "a1",
      type: "thinking",
      text: "Reading the niche brief: independent coffee shops in Nashville",
      at: 0,
    },
    {
      id: "a2",
      type: "searching",
      text: "Scanning local calendars, review sites, and supplier chatter",
      at: 1800,
    },
    {
      id: "a3",
      type: "analyzing",
      text: "Mapping demand spikes against staffing and inventory risks",
      at: 3400,
    },
    {
      id: "a4",
      type: "signal",
      text: "Signal: weekend event cluster likely to strain 5 shops. Drafting an action plan.",
      at: 5600,
    },
    {
      id: "a5",
      type: "done",
      text: "Pass complete. Recommendation queued for token-holder review.",
      at: 7200,
    },
  ],
  [
    {
      id: "b1",
      type: "thinking",
      text: "Checking governance priorities from the latest member vote...",
      at: 0,
    },
    {
      id: "b2",
      type: "searching",
      text: "Ranking requested work by impact, cost, and mission fit",
      at: 2000,
    },
    {
      id: "b3",
      type: "analyzing",
      text: "Estimating budget needed for the next agent capability",
      at: 3800,
    },
    {
      id: "b4",
      type: "signal",
      text: "Signal: route automation beats dashboard polish this epoch.",
      at: 5400,
    },
    {
      id: "b5",
      type: "done",
      text: "Pass complete. Draft budget proposal ready for governance.",
      at: 6800,
    },
  ],
  [
    {
      id: "c1",
      type: "thinking",
      text: "Tallying contribution receipts for the current epoch...",
      at: 0,
    },
    {
      id: "c2",
      type: "searching",
      text: "Matching merged work, reviewed signals, and verified outcomes",
      at: 1600,
    },
    {
      id: "c3",
      type: "analyzing",
      text: "Calculating token weights before the next priority vote",
      at: 3200,
    },
    {
      id: "c4",
      type: "done",
      text: "Pass complete. Governance distribution ready to review.",
      at: 5000,
    },
  ],
];

/* ─── SHOWCASE CARDS ──────────────────────────────────────────────────────
 * A grid of cards showing what the node tracks / produces. The two-segment bar
 * is a generic split (e.g. Yes/No, Open/Closed, On-track/At-risk) — name the
 * segments per item. Replace the category list and the cards with your domain.
 */
export interface ShowcaseOutcome {
  label: string;
  /** 0-100; the two outcomes in a card should sum to ~100. */
  value: number;
}

export interface ShowcaseItem {
  id: string;
  title: string;
  /** Must match one of SHOWCASE_CATEGORIES (besides "All"). */
  category: string;
  /** Free-text source / origin shown in muted text. */
  source: string;
  /** Headline number shown top-right, e.g. "$4.2M" or "94%". */
  metric: string;
  /** 24h-style delta in percent; positive = up (success), negative = down. */
  change: number;
  /** Two-segment split bar. */
  outcomes: [ShowcaseOutcome, ShowcaseOutcome];
  /** Left footer meta (e.g. volume, members, size). */
  footerLeft: string;
  /** Right footer meta (e.g. "Updated 2h ago", "Resolves Jun 18"). */
  footerRight: string;
}

export const SHOWCASE_SECTION = {
  eyebrow: "Launch pattern",
  heading: "A full node, ready to specialize.",
  subhead:
    "The layout is already here: mission intake, agent work, contribution accounting, and governance. Swap in your niche, copy, and colors — then let the node start producing useful work.",
} as const;

export const SHOWCASE_CATEGORIES = [
  "All",
  "Niche",
  "Agent",
  "Tokens",
  "Governance",
] as const;

export const SHOWCASE_ITEMS: ShowcaseItem[] = [
  {
    id: "1",
    title: "Pick a narrow mission the AI can actually serve",
    category: "Niche",
    source: "Node brief",
    metric: "1",
    change: 12,
    outcomes: [
      { label: "Focused", value: 82 },
      { label: "Vague", value: 18 },
    ],
    footerLeft: "Coffee, local policy, markets",
    footerRight: "First decision",
  },
  {
    id: "2",
    title: "Set the agent loose on research, monitoring, and action",
    category: "Agent",
    source: "Mission loop",
    metric: "24/7",
    change: 9,
    outcomes: [
      { label: "Autonomous", value: 74 },
      { label: "Manual", value: 26 },
    ],
    footerLeft: "Watchlists + workflows",
    footerRight: "Always on",
  },
  {
    id: "3",
    title: "Reward useful work with governance token weight",
    category: "Tokens",
    source: "Activity ledger",
    metric: "100%",
    change: 6,
    outcomes: [
      { label: "Earned", value: 68 },
      { label: "Unclaimed", value: 32 },
    ],
    footerLeft: "Receipts, reviews, outcomes",
    footerRight: "Epoch based",
  },
  {
    id: "4",
    title: "Vote on what the AI should learn and fund next",
    category: "Governance",
    source: "Treasury + roadmap",
    metric: "DAO",
    change: 5,
    outcomes: [
      { label: "Members", value: 79 },
      { label: "Founder", value: 21 },
    ],
    footerLeft: "Priorities + budget",
    footerRight: "Next vote",
  },
];

/* ─── ACTIVITY FEED ───────────────────────────────────────────────────────
 * "What the agent is thinking" — public, explainable output. Each signal shows
 * the call, a confidence, the reasoning, and the sources. This is where you
 * prove the node works in the open. Rewrite for your domain.
 */
export type SignalDirection = "positive" | "negative" | "neutral";

export interface FeedSignal {
  id: string;
  title: string;
  category: string;
  source: string;
  direction: SignalDirection;
  /** 0-100 self-reported confidence. */
  confidence: number;
  /** The agent's reasoning, 1-2 sentences. */
  thesis: string;
  /** Citations / inputs the agent used. */
  sources: string[];
  /** Human-friendly relative time, e.g. "2m ago". */
  timestamp: string;
}

export const FEED_SECTION = {
  eyebrow: "Example node loop",
  heading: "From blank template to governed AI.",
  subhead:
    "This default feed shows the shape of a real node: pick a niche, make the AI useful, account for work, and let token holders steer what happens next.",
} as const;

/** The status-bar verbs and the running totals shown above the feed. */
export const FEED_STATUS = {
  scannedLabel: "template events",
  signalsLabel: "launch steps",
  startScanned: 2847,
  signalsToday: 12,
} as const;

export const FEED_SIGNALS: FeedSignal[] = [
  {
    id: "s1",
    title: "Niche selected: Nashville independent coffee ops",
    category: "Niche",
    source: "Launch brief",
    direction: "positive",
    confidence: 86,
    thesis:
      "The mission is narrow enough for the agent to monitor real-world sources and broad enough for contributors to improve the playbook.",
    sources: ["Node brief", "Local events", "Operator handoff"],
    timestamp: "2m ago",
  },
  {
    id: "s2",
    title: "Agent run proposed: event-driven staffing forecast",
    category: "Agent",
    source: "Mission loop",
    direction: "positive",
    confidence: 72,
    thesis:
      "A focused forecast is an early useful behavior: clear inputs, visible outputs, and an outcome the community can judge.",
    sources: ["Event feeds", "Store hours", "Past signals"],
    timestamp: "8m ago",
  },
  {
    id: "s3",
    title: "Contribution receipts ready for token accounting",
    category: "Tokens",
    source: "Activity ledger",
    direction: "neutral",
    confidence: 69,
    thesis:
      "Useful work should become governance weight only after it is reviewable: merged changes, verified research, and accepted operations all leave receipts.",
    sources: ["PR history", "Review notes", "Activity ledger"],
    timestamp: "14m ago",
  },
  {
    id: "s4",
    title: "First governance question drafted",
    category: "Governance",
    source: "Roadmap",
    direction: "positive",
    confidence: 76,
    thesis:
      "Token holders should decide whether the next budget goes to better source coverage, stronger automation, or a public dashboard.",
    sources: ["Treasury", "Roadmap", "Member requests"],
    timestamp: "21m ago",
  },
];

/* ─── STATS ───────────────────────────────────────────────────────────────
 * The closing band of big numbers. Keep them true and specific to your node.
 */
export interface StatItem {
  value: string;
  label: string;
}

export const STATS: StatItem[] = [
  { value: "1", label: "Niche" },
  { value: "1", label: "Mission" },
  { value: "24/7", label: "AI Worker" },
  { value: "DAO", label: "Governance" },
];

/* ─── STREAM ICONS ────────────────────────────────────────────────────────
 * Maps stream event types to icons. You usually won't need to touch this.
 */
export const STREAM_ICONS: Record<StreamEventType, LucideIcon> = {
  thinking: BrainCircuit,
  searching: Search,
  analyzing: Activity,
  signal: Sparkles,
  done: CheckCircle,
};

export const SECTION_ICON: LucideIcon = Network;
