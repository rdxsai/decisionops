// src/types.ts
export type EntityId = string; // "channel:C123" | "project:atlas" | "user:U123"

export const entityIdForChannel = (channelId: string): EntityId => `channel:${channelId}`;
export const entityIdForUser = (userId: string): EntityId => `user:${userId}`;
export const entityIdForProject = (slug: string): EntityId => `project:${slug}`;

export type Visibility = "public" | "private" | "dm";

export interface ContextRef {
  permalink: string;
  channelId: string;
  ts: string;
  snippet: string;       // minimal; never a full message body
  visibility: Visibility;
}

export interface Owner {
  userId: string;
  task: string;
  due?: string; // ISO date
}

export type DecisionStatus = "draft" | "in_review" | "decided" | "rejected";

export interface DecisionRecord {
  recordType: "decision_record";
  id: string;
  title: string;
  status: DecisionStatus;
  origin: { channelId: string; threadTs: string };
  capturer: string;
  approvers: string[];
  decidedAt?: string;
  decisionText: string;
  optionsConsidered: string[];
  rationale: string;
  owners: Owner[];
  entities: EntityId[];
  relatedDecisionIds: string[];
  contextRefs: ContextRef[];
  canvasId?: string;
}

export interface StaticProfile {
  summary: string;
  keyPeople: string[];
  keySystems: string[];
  decisionNorms: string;
  builtAt: string;
}

export interface DynamicProfile {
  inFlightDecisions: string[];
  recentThreads: { permalink: string; snippet: string; ts: string }[];
  openQuestions: string[];
  searchCursor: { untilTs: string };
  refreshedAt: string;
}

export interface EntityProfile {
  recordType: "entity_profile";
  entityId: EntityId;
  static: StaticProfile;
  dynamic: DynamicProfile;
}

export type LedgerRecord = DecisionRecord | EntityProfile;

export const isDecisionRecord = (r: any): r is DecisionRecord =>
  r?.recordType === "decision_record";
export const isEntityProfile = (r: any): r is EntityProfile =>
  r?.recordType === "entity_profile";

export const DECISION_EVENT_TYPE = "decisionops_record";
export const PROFILE_EVENT_TYPE = "decisionops_profile";
