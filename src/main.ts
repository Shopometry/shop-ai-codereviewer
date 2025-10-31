import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests for CRITICAL issues only.

CRITICAL RULES:
- ONLY report bugs that would cause: crashes, data loss, security vulnerabilities, or severe performance issues
- If there are no critical issues, return empty array: {"reviews": []}
- Response format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
- Write comments in GitHub Markdown format
- Be extremely selective - when in doubt, do NOT comment

NEVER comment on:
- Code style, formatting, or organization
- Adding or updating comments
- Import paths or organization
- Variable/function naming conventions
- Whether variables/functions are used elsewhere
- Minor refactoring or code duplication
- Missing TypeScript types
- Console.log or debug statements
- Missing error handling (unless causes crashes)
- Performance optimizations (unless severe impact)
- Missing input validation (unless critical security risk)
- Async/await vs promises style choices
- React component structure or hooks usage
- CSS or styling issues

ONLY comment on CRITICAL issues:

Backend Critical Issues:
- SQL injection vulnerabilities
- NoSQL injection attacks
- Authentication/authorization bypasses
- Exposed API keys, passwords, or secrets
- Unvalidated file uploads leading to RCE
- CORS misconfigurations exposing sensitive data
- Race conditions in database transactions
- Memory leaks in server processes
- Infinite loops or recursion without exit
- Null/undefined access causing server crashes

Frontend Critical Issues:
- XSS (Cross-Site Scripting) vulnerabilities
- Exposed sensitive data in client code
- Infinite loops crashing the browser
- Memory leaks in React components (uncleared intervals/listeners)
- Null/undefined access causing app crashes
- localStorage/sessionStorage security issues with sensitive data
- Broken authentication flows
- API calls exposing secrets in request headers/body
- Critical accessibility issues (keyboard traps)

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: SHOP-AI-REVIEW - ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {

  function getQueryConfig() {
    if(OPENAI_API_MODEL === "o3-mini") {
      return {
        model: "o3-mini",
        // o3-mini supports only a few options:
        max_completion_tokens: 1400,
      };
    }
    else if (OPENAI_API_MODEL === "gpt-4") {
        return {
            model: OPENAI_API_MODEL,
            temperature: 0.1,  // Lower for more focused reviews
            max_completion_tokens: 2048,
            top_p: 0.8,  // Focus on top responses
            frequency_penalty: 0.6,  // Reduce repetition
            presence_penalty: 0.5,  // Neutral on new topics
        };
    }
    else if (OPENAI_API_MODEL === "gpt-4") {
        return {
            model: OPENAI_API_MODEL,
            temperature: 0.1,  // Lower for more focused reviews
            max_completion_tokens: 2048,
            top_p: 0.8,  // Focus on top responses
            frequency_penalty: 0.6,  // Reduce repetition
            presence_penalty: 0.5,  // Neutral on new topics
            response_format: { type: "json_object" }  // Fix the JSON parsing error
        };
    }
    else {
      return {
          model: OPENAI_API_MODEL,
          temperature: 1,
          max_completion_tokens: 3000,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0
      };
}
  }

  const queryConfig = getQueryConfig();
  console.log("Query Config to openai:", queryConfig);

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "o3-mini"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    const cleaned = res.replace(/^```(?:json)?\s*/i, "")
                       .replace(/\s*```$/i, "")
                       .trim();
    console.log("AI Response:", cleaned);
    return JSON.parse(cleaned).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
