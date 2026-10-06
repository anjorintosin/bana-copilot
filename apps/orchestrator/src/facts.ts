/** Languages and tools the model likes to invent. Only allow ones that appear in the documents. */

type StackTerm = { label: string; re: RegExp };

const STACK: StackTerm[] = [
  { label: "TypeScript", re: /\bTypeScript\b/i },
  { label: "JavaScript", re: /\bJavaScript\b|\bNode\.?js\b/i },
  { label: "Java", re: /\bJava\b(?!\s*Script)/i },
  { label: "Python", re: /\bPython\b|\bDjango\b|\bFlask\b|\bFastAPI\b/i },
  { label: "C++", re: /\bC\+\+\b/ },
  { label: "C#", re: /\bC#\b|\b\.NET\b|\bdotnet\b/i },
  { label: "Go", re: /\bGolang\b|\bGo lang\b/i },
  { label: "Rust", re: /\bRust\b/i },
  { label: "Ruby", re: /\bRuby\b|\bRails\b/i },
  { label: "PHP", re: /\bPHP\b/i },
  { label: "Swift", re: /\bSwift\b/i },
  { label: "Kotlin", re: /\bKotlin\b/i },
  { label: "Scala", re: /\bScala\b/i },
  { label: "SQL", re: /\bSQL\b|\bPostgreSQL\b|\bPostgres\b|\bMySQL\b/i },
  { label: "React", re: /\bReact(?:\.?js)?\b|\bNext\.js\b/i },
  { label: "Vue", re: /\bVue(?:\.?js)?\b/i },
  { label: "Angular", re: /\bAngular\b/i },
  { label: "Node.js", re: /\bNode\.?js\b/i },
  { label: "Electron", re: /\bElectron(?:\.?js)?\b/i },
  { label: "Express", re: /\bExpress(?:\.?js)?\b/i },
  { label: "PostgreSQL", re: /\bPostgreSQL\b|\bPostgres\b/i },
  { label: "MongoDB", re: /\bMongoDB\b|\bMongo\b/i },
  { label: "Redis", re: /\bRedis\b/i },
  { label: "Kafka", re: /\bKafka\b/i },
  { label: "AWS", re: /\bAWS\b|\bAmazon Web Services\b/i },
  { label: "GCP", re: /\bGCP\b|\bGoogle Cloud\b/i },
  { label: "Azure", re: /\bAzure\b/i },
  { label: "Docker", re: /\bDocker\b/i },
  { label: "Kubernetes", re: /\bKubernetes\b|\bK8s\b/i },
  { label: "Terraform", re: /\bTerraform\b/i },
  { label: "GraphQL", re: /\bGraphQL\b/i },
];

const OFTEN_INVENTED = [
  "Java",
  "Python",
  "C++",
  "C#",
  "Go",
  "Rust",
  "Kotlin",
  "Swift",
  "PHP",
  "Ruby",
  "Scala",
];

function section(raw: string, heading: RegExp, max: number) {
  const match = raw.match(heading);
  if (!match || match.index == null) return "";
  const from = match.index;
  const rest = raw.slice(from, from + max + 200);
  const next = rest.slice(match[0].length).search(/\n[A-Z][A-Za-z /&]{2,32}\n/);
  const body = next >= 0 ? rest.slice(0, match[0].length + next) : rest.slice(0, max);
  return body.replace(/\s+/g, " ").trim();
}

export function extractStack(text: string): string[] {
  const found: string[] = [];
  for (const term of STACK) {
    if (term.re.test(text) && !found.includes(term.label)) found.push(term.label);
  }
  return found;
}

export function sliceResumeForBrief(raw: string) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const skills = section(
    raw,
    /\b(skills|technical skills|tech stack|technologies)\b/i,
    1400,
  );
  const experience = section(
    raw,
    /\b(experience|work experience|work history|employment|professional experience)\b/i,
    2800,
  );
  const parts = [skills, experience].filter((part) => part.length > 40);
  if (parts.length) {
    return `${parts.join("\n\n")}\n\n${text}`.slice(0, 5200);
  }
  return text.slice(0, 5200);
}

export function formatGroundTruth(input: {
  resume?: string | null;
  job?: string | null;
  title?: string | null;
  company?: string | null;
  requirements?: string | null;
}) {
  const corpus = [input.resume, input.job, input.title, input.company, input.requirements]
    .filter(Boolean)
    .join("\n");
  const stack = extractStack(corpus);
  const doNotInvent = OFTEN_INVENTED.filter((name) => !stack.includes(name));
  const lines = [
    "Ground truth — only these facts. If a language, employer, skill, or metric is not here, do not say it.",
    stack.length
      ? `My stack (only these languages/tools): ${stack.join(", ")}.`
      : "My stack is not listed. Do not name a programming language unless they asked it or it is on screen.",
    doNotInvent.length
      ? `Do not mention or claim: ${doNotInvent.join(", ")}.`
      : "",
    "If they ask about a stack I do not have, say I have not used it and answer the concept without claiming experience.",
    "Do not invent employers, teams, titles, or numbers. If no story fits, say so and give a general approach.",
  ];
  return {
    stack,
    doNotInvent,
    block: lines.filter(Boolean).join("\n"),
  };
}
