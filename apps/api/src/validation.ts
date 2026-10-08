import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export const id = z.string().uuid();
export const text = (max = 500) => z.string().trim().min(1).max(max);
export const money = z.number().int().min(1).max(1000000);
export const productInput = z
  .object({
    title: text(100),
    topicId: id,
    categoryId: id,
    locationId: id,
    condition: text(300),
    handoff: text(300),
    price: money,
    frontMediaId: id,
    backMediaId: id,
  })
  .strict();
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
    );
  return result.data;
}
export function page(value: unknown) {
  return parse(z.coerce.number().int().min(1).max(10000).default(1), value);
}
