/**
 * Regeneration — PRD §4.2 "Regenerate".
 *
 * A use case, not a route: it re-runs the local pipeline over the ORIGINAL raw
 * article and returns both versions so the caller can show a diff. It never
 * writes; applying is a separate, explicit step.
 */
import type { Database } from 'better-sqlite3';
import { NotFoundError } from '../core/errors.js';
import {
  createArticleRepository, type AdminArticle,
} from '../db/repositories/articleRepository.js';
import { createRawArticleRepository } from '../db/repositories/rawArticleRepository.js';
import { loadLocalPipelineConfig, simplifyLocally } from '../pipeline/localPipeline.js';

export interface RegenerationPreview {
  current: AdminArticle;
  generated: AdminArticle;
}

export function regenerateArticle(db: Database, id: string): RegenerationPreview {
  const articles = createArticleRepository(db);
  const rawArticles = createRawArticleRepository(db);

  const current = articles.findAdminById(id);
  if (!current) throw NotFoundError.of('article', id);

  const raw = rawArticles.findById(current.originalId);
  if (!raw) throw NotFoundError.of('raw article', current.originalId);

  const { article } = simplifyLocally(
    {
      id: raw.id,
      headline: raw.headline,
      body: raw.body,
      topic: raw.topic,
      sourceName: raw.sourceName,
      sourceUrl: raw.sourceUrl,
    },
    loadLocalPipelineConfig(db, current.ageTarget),
    { id: current.id, now: current.createdAt },
  );

  return {
    current,
    // Identity and lifecycle fields are carried over, so the diff shows only
    // what regeneration would actually change.
    generated: {
      ...article,
      status: current.status,
      publishedAt: current.publishedAt,
      rejectReason: current.rejectReason,
      editedByHuman: false,
      sourceId: current.sourceId,
      originalHeadline: current.originalHeadline,
    },
  };
}
