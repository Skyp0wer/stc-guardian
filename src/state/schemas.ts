import { z } from 'zod'

/** Zod-схема для SkipInfo */
export const SkipInfoSchema = z.object({
  reason: z.string(),
  at: z.string(),
})

/** Zod-схема для SatisfyInfo */
export const SatisfyInfoSchema = z.object({
  evidence: z.string(),
  at: z.string(),
})

/** Zod-схема для StepInfo */
export const StepInfoSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'active', 'done']),
})

/** Zod-схема для FeatureState */
export const FeatureStateSchema = z.object({
  spec_path: z.string().nullable(),
  registration_source: z.enum(['discovered_from_spec', 'registered_explicitly']),
  pipeline: z.string().default('stc'),
  current_phase: z.string(),
  current_step: z.number().int().min(0),
  total_steps: z.number().int().min(0),
  steps: z.array(StepInfoSchema).optional(),
  verify_passed: z.boolean().optional(),
  phases_completed: z.array(z.string()),
  phases_skipped: z.record(z.string(), SkipInfoSchema),
  phases_satisfied: z.record(z.string(), SatisfyInfoSchema),
  created_at: z.string(),
  updated_at: z.string(),
})

/** Zod-схема для GuardianState */
export const GuardianStateSchema = z.object({
  version: z.number().int().min(1),
  pipeline: z.string(),
  features: z.record(z.string(), FeatureStateSchema),
  active_feature: z.string().nullable(),
})

/** Zod-схема для AuditEvent */
export const AuditEventSchema = z.object({
  timestamp: z.string(),
  feature: z.string(),
  action: z.string(),
  phase: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
