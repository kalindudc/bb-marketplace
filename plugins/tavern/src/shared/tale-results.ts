import { z } from "zod";

export const taleResultsSchema = z.object({
  figures: z.array(z.object({
    label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(24),
    note: z.string().trim().max(80).optional(),
  }).strict()).max(4).default([]),
  chart: z.object({
    title: z.string().trim().min(1).max(80), type: z.enum(["bars", "trend"]),
    unit: z.string().trim().max(12).optional(),
    labels: z.array(z.string().trim().min(1).max(24)).min(2).max(12),
    series: z.array(z.object({ name: z.string().trim().min(1).max(24), values: z.array(z.number().finite()).min(2).max(12) }).strict()).min(1).max(3),
  }).strict().superRefine((chart, ctx) => {
    chart.series.forEach((series, i) => {
      if (series.values.length !== chart.labels.length) ctx.addIssue({ code: "custom", path: ["series", i, "values"], message: "Give one value per label in each results series" });
    });
  }).optional(),
}).strict().refine(results => results.figures.length > 0 || !!results.chart, { message: "Give at least one figure or a chart in results" });
export type TaleResults = z.infer<typeof taleResultsSchema>;
