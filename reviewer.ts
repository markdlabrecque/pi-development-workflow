import type { FindingCategory, ReviewFinding } from "./workflow-state.ts";
const categories = new Set<FindingCategory>(["must_fix", "quick_fix", "follow_up", "advisory", "approved"]);
export function parseReviewerOutput(output: string): ReviewFinding[] {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]; const candidate = fenced ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Reviewer output did not contain JSON");
  let value: unknown; try { value = JSON.parse(candidate); } catch (error: any) { throw new Error(`Invalid Reviewer JSON: ${error.message}`); }
  const raw = Array.isArray(value) ? value : (value as any)?.findings;
  if (!Array.isArray(raw)) throw new Error("Reviewer JSON must contain a findings array");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || !categories.has(item.category) || typeof item.title !== "string" || !item.title.trim()) throw new Error(`Invalid Reviewer finding at index ${index}`);
    return { category: item.category, title: item.title.trim(), detail: typeof item.detail === "string" ? item.detail : undefined, file: typeof item.file === "string" ? item.file : undefined, line: Number.isInteger(item.line) ? item.line : undefined };
  });
}
