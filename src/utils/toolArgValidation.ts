/**
 * Enforcement of each tool's declared inputSchema.required list.
 *
 * The MCP SDK does not validate tool arguments against the inputSchema, so a
 * call like list_pools({}) used to flow straight into URL interpolation and
 * reach Intersight as GET /v1/undefined — answered with an opaque
 * 403 InvalidUrl that told the calling agent nothing about the real mistake.
 * This check runs before dispatch and turns that into an actionable error.
 */

/** The subset of an MCP Tool definition the validator needs. */
export interface ToolDefinitionLike {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Validate `args` against the tool's required-argument list.
 * Returns a human/agent-actionable error message, or null when the call is
 * well-formed. Only presence is checked (undefined, null, blank string);
 * type and format stay the handlers' business.
 */
export function validateToolArgs(
  tool: ToolDefinitionLike,
  args: Record<string, unknown>
): string | null {
  const required = tool.inputSchema?.required ?? [];
  const problems: string[] = [];

  for (const key of required) {
    const value = args[key];
    let problem: string | null = null;
    if (value === undefined) {
      problem = 'is missing';
    } else if (value === null) {
      problem = 'is null';
    } else if (typeof value === 'string' && value.trim() === '') {
      problem = 'is empty';
    }
    if (!problem) {
      continue;
    }

    let hint = '';
    if (value === undefined) {
      const nearMiss = findNearMissKey(key, args);
      if (nearMiss) {
        hint = ` (did you mean '${key}' instead of '${nearMiss}'?)`;
      }
    }

    const description = propertyDescription(tool.inputSchema?.properties?.[key]);
    const expected = description ? ` — expected: ${description}` : '';
    problems.push(`required argument '${key}' ${problem}${hint}${expected}`);
  }

  if (problems.length === 0) {
    return null;
  }
  return `Invalid arguments for tool '${tool.name}': ${problems.join('; ')}`;
}

/**
 * Find a provided key that is the required key in disguise — agents commonly
 * send pool_type for poolType, or PoolType. Matching is case-insensitive and
 * ignores '_' and '-'.
 */
function findNearMissKey(requiredKey: string, args: Record<string, unknown>): string | null {
  const target = normalizeKey(requiredKey);
  for (const provided of Object.keys(args)) {
    if (provided !== requiredKey && normalizeKey(provided) === target) {
      return provided;
    }
  }
  return null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function propertyDescription(property: unknown): string | undefined {
  if (property && typeof property === 'object' && 'description' in property) {
    const description = (property as { description?: unknown }).description;
    if (typeof description === 'string') {
      return description;
    }
  }
  return undefined;
}
