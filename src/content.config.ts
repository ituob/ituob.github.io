import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "zod";

/**
 * Content collections for any editorial MDX content (about pages, blog
 * posts, documentation). The bulk of the site's data (issues, datasets) is
 * loaded directly from disk via src/lib/loaders.ts, NOT through these
 * collections — the data lives in sibling repositories and would be
 * wasteful to copy in. This config exists for future editorial content
 * authored directly in this repo.
 */
const editorial = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/editorial" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    publishedAt: z.coerce.date().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { editorial };
