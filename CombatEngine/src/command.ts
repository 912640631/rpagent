/** The single wire protocol for CLI and both Agent tools. Types and validation follow this schema. */
export const commandSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: {
      type: { const: 'action' }, id: { type: 'string' }, part: { type: 'string' }, choice: { type: 'string' },
      advantage: { enum: ['none', 'advantage', 'disadvantage'] },
      useHopeAdvantage: { type: 'boolean' }, empowerHit: { type: 'boolean' }, empowerDamage: { type: 'boolean' }
    } },
    { type: 'object', additionalProperties: false, required: ['type', 'choice'], properties: {
      type: { const: 'decision' }, choice: { type: 'string' }
    } }
  ]
} as const;

type Field = { readonly const: string } | { readonly enum: readonly string[] } | { readonly type: 'string' | 'boolean' };
type FieldType<F> = F extends { readonly const: infer C } ? C :
  F extends { readonly enum: readonly (infer E)[] } ? E :
  F extends { readonly type: 'string' } ? string : F extends { readonly type: 'boolean' } ? boolean : never;
type BranchType<B extends { readonly properties: Record<string, Field>; readonly required: readonly string[] }> =
  { -readonly [K in keyof B['properties'] as K extends B['required'][number] ? K : never]: FieldType<B['properties'][K]> } &
  { -readonly [K in keyof B['properties'] as K extends B['required'][number] ? never : K]?: FieldType<B['properties'][K]> };
export type ActionCommand = BranchType<typeof commandSchema.oneOf[0]>;
export type DecisionCommand = BranchType<typeof commandSchema.oneOf[1]>;
export type Command = ActionCommand | DecisionCommand;

export function validCommand(value: unknown): value is Command {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return commandSchema.oneOf.some(branch => {
    const fields: Record<string, Field> = branch.properties;
    if (!branch.required.every(key => Object.hasOwn(command, key))) return false;
    return Object.keys(command).every(key => {
      const field = fields[key];
      if (!field) return false;
      const item = command[key];
      // Optional undefined matches the existing in-process Command contract; JSON omits it.
      if (item === undefined && !(branch.required as readonly string[]).includes(key)) return true;
      if ('const' in field) return item === field.const;
      if ('enum' in field) return typeof item === 'string' && field.enum.includes(item);
      return typeof item === field.type;
    });
  });
}
