import type { InterviewTrackId } from "@meeting-copilot/types";
import type { SpecialistId } from "./specialists.js";

export type Track = {
  id: InterviewTrackId;
  label: string;
  defaultRole: string;
  /** Specialists that may answer in this interview. */
  specialists: SpecialistId[];
  /** Used when the router has no strong signal. */
  fallback: SpecialistId;
  /** Domain words that help speech-to-text spell things correctly. */
  vocabulary: string;
};

const BASE: SpecialistId[] = ["motivation", "behavioral", "general"];

export const TRACKS: Record<InterviewTrackId, Track> = {
  auto: {
    id: "auto",
    label: "Auto-detect",
    defaultRole: "the role",
    specialists: [
      ...BASE,
      "coding",
      "system_design",
      "technical",
      "product",
      "metrics",
      "case",
      "finance",
      "sales",
      "design",
    ],
    fallback: "general",
    vocabulary:
      "STAR method, LeetCode, Big O, system design, KPI, A/B test, market sizing, EBITDA, DCF, quota, pipeline, Figma.",
  },
  software: {
    id: "software",
    label: "Software engineering",
    defaultRole: "a software engineer role",
    specialists: [...BASE, "coding", "system_design", "technical"],
    fallback: "technical",
    vocabulary:
      "LeetCode, Big O, hash map, binary tree, linked list, two pointers, dynamic programming, REST, GraphQL, Postgres, Redis, Kafka, Kubernetes, latency, throughput, CAP theorem, ACID, sharding, load balancer, microservice.",
  },
  data: {
    id: "data",
    label: "Data & analytics",
    defaultRole: "a data role",
    specialists: [...BASE, "metrics", "technical", "coding"],
    fallback: "metrics",
    vocabulary:
      "SQL, window function, CTE, join, p-value, confidence interval, A/B test, regression, cohort, retention, churn, pandas, Spark, dbt, Snowflake, precision, recall.",
  },
  product: {
    id: "product",
    label: "Product management",
    defaultRole: "a product manager role",
    specialists: [...BASE, "product", "metrics", "technical"],
    fallback: "product",
    vocabulary:
      "roadmap, prioritization, RICE, north star metric, DAU, MAU, retention, funnel, MVP, go-to-market, PRD, stakeholder, OKR.",
  },
  design: {
    id: "design",
    label: "Design & UX",
    defaultRole: "a product designer role",
    specialists: [...BASE, "design", "product"],
    fallback: "design",
    vocabulary:
      "Figma, design system, usability testing, user research, wireframe, prototype, accessibility, WCAG, heuristic evaluation, information architecture.",
  },
  consulting: {
    id: "consulting",
    label: "Consulting & case",
    defaultRole: "a consulting role",
    specialists: [...BASE, "case"],
    fallback: "case",
    vocabulary:
      "MECE, market sizing, profitability, revenue, costs, break-even, hypothesis, framework, synergies, due diligence, our client.",
  },
  finance: {
    id: "finance",
    label: "Finance & banking",
    defaultRole: "a finance role",
    specialists: [...BASE, "finance", "case", "technical"],
    fallback: "finance",
    vocabulary:
      "DCF, WACC, EBITDA, enterprise value, equity value, LBO, accretion, dilution, balance sheet, income statement, cash flow statement, working capital, IRR, NPV, multiples.",
  },
  sales: {
    id: "sales",
    label: "Sales & customer success",
    defaultRole: "a sales role",
    specialists: [...BASE, "sales"],
    fallback: "sales",
    vocabulary:
      "quota, pipeline, discovery call, objection handling, ARR, ACV, churn, upsell, MEDDIC, BANT, SaaS, CRM, Salesforce.",
  },
  marketing: {
    id: "marketing",
    label: "Marketing & growth",
    defaultRole: "a marketing role",
    specialists: [...BASE, "metrics", "product"],
    fallback: "general",
    vocabulary:
      "CAC, LTV, ROAS, funnel, conversion rate, SEO, SEM, positioning, brand, campaign, attribution, lifecycle, retention.",
  },
  general: {
    id: "general",
    label: "General / any role",
    defaultRole: "the role",
    specialists: [...BASE, "technical"],
    fallback: "general",
    vocabulary: "STAR method, teamwork, stakeholder, deadline, customer, leadership.",
  },
};

export function getTrack(id?: string): Track {
  return TRACKS[(id as InterviewTrackId) ?? "auto"] ?? TRACKS.auto;
}
