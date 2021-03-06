import { DangerResults } from "danger/distribution/dsl/DangerResults"
import { DangerRun } from "../../../danger/danger_run"
import { runDangerForInstallation } from "../../../danger/danger_runner"
import { canUserWriteToRepo, getGitHubFileContents } from "../../lib/github_helpers"
import { createPRJSONDSL } from "../createPRDSL"
import { GitHubRunSettings } from "../github_runner"
import { Pull_request } from "../types/pull_request_updated.types"
import { githubAPIForCommentable } from "../utils/commenting"

export const runPRRun = async (
  run: DangerRun,
  settings: GitHubRunSettings,
  token: string,
  pr: Pull_request
): Promise<DangerResults | null> => {
  if (!settings.repoName) {
    console.error("An event without a repo name was passed to runRPRun") // tslint:disable-line
    return null
  }

  if (!settings.triggeredByUsername) {
    console.error("An event without a username was passed to runRPRun") // tslint:disable-line
    return null
  }

  if (!pr.head.repo) {
    console.error("An event without a head repo was passed to runPRRun") // tslint:disable-line
    return null
  }

  const githubAPI = githubAPIForCommentable(token, settings.repoName, settings.commentableID)

  // In theory only a PR requires a custom branch, so we can check directly for that
  // in the event JSON and if it's not there then use master
  // prioritise the run metadata

  const dangerfileRepoForPR = pr.head.repo.full_name
  const dangerfileBranchForPR = pr.head.ref
  const neededDangerfileIsLocalRepo = !run.repoSlug
  const branch = neededDangerfileIsLocalRepo ? dangerfileBranchForPR : null

  // Either it's dictated in the run as an external repo, or we use the most natural repo
  const repoForDangerfile = run.repoSlug || dangerfileRepoForPR

  const baseDangerfile = await getGitHubFileContents(token, repoForDangerfile, run.dangerfilePath, branch)
  const headDangerfile = await getGitHubFileContents(token, repoForDangerfile, run.dangerfilePath, branch)
  const dangerfilesExist = headDangerfile !== "" && baseDangerfile !== ""

  // Shortcut to determine if both Dangerfile exists, and that they have different content
  if (dangerfilesExist && baseDangerfile !== headDangerfile) {
    // Check to see if they have write access, if they don't then don't run the
    // Dangerfile, but put out a message that it's not being ran on purpose
    const userCanWrite = await canUserWriteToRepo(token, settings.triggeredByUsername, dangerfileRepoForPR)
    if (!userCanWrite) {
      const message = "Not running Danger rules due to user with no write access changing the Dangerfile."
      return {
        fails: [],
        markdowns: [],
        warnings: [],
        messages: [{ message }],
      }
    }
  }

  const reportData = (reason: string) => {
    const stateForErrorHandling = {
      branch,
      dangerfileBranchForPR,
      neededDangerfileIsLocalRepo,
      repoForDangerfile,
      run,
      settings,
    }

    return `${reason}

## Full state of PR run:

\`\`\`json
${JSON.stringify(stateForErrorHandling, null, "  ")}
\`\`\`
      `
  }

  if (headDangerfile === "") {
    const actualBranch = branch ? branch : "master"
    const message = `Could not find Dangerfile at <code>${
      run.dangerfilePath
    }</code> on <code>${repoForDangerfile}</code> on branch <code>${actualBranch}</code>`

    const report = reportData(message)
    return {
      fails: [{ message: report }],
      markdowns: [],
      warnings: [],
      messages: [],
    }
  } else {
    // Everything is :+1:

    const installationSettings = {
      iID: settings.installationID,
      settings: settings.installationSettings,
    }

    const dangerDSL = await createPRJSONDSL(githubAPI)
    const results = await runDangerForInstallation(
      headDangerfile,
      run.referenceString,
      githubAPI,
      run.dslType,
      installationSettings,
      {
        dsl: dangerDSL,
        webhook: null,
      }
    )

    if (results && pr.body && pr.body.includes("Peril: Debug")) {
      results.markdowns.push({ message: reportData("Showing PR details due to including 'Peril: Debug'") })
    }
    return results ? results : null
  }
}
