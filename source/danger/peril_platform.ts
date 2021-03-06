import { GitHubUtilsDSL } from "danger/distribution/dsl/GitHubDSL"
import { GitHub } from "danger/distribution/platforms/GitHub"

import { Platform } from "danger/distribution/platforms/platform"
import { RunType } from "./danger_run"

/**
 * When Peril is running a dangerfile for a PR we can use the default GitHub from Danger
 * however, an event like an issue comment or a user creation has no way to provide any kind of
 * feedback or DSL. To work around that we use the event provided by GitHub and provide it to Danger.
 */
export const getPerilPlatformForDSL = (type: RunType, github: GitHub | null, githubEvent: any): Platform => {
  if (type === RunType.pr && github) {
    return github
  } else {
    // This bit of faffing ensures that as the gh utils expands we get
    // compiler errors in peril
    const utils: GitHubUtilsDSL | null = github && {
      fileContents: github && github.api.fileContents,
      // Not sure what this looks like for non-PR events
      fileLinks: (paths, _, __, ___) => paths.join(", "),
    }

    const nullFunc: any = () => ""
    const platform: Platform = {
      name: "Peril",
      getFileContents: github ? github.getFileContents.bind(github) : nullFunc,

      createComment: github ? github.createComment.bind(github) : nullFunc,
      deleteMainComment: github ? github.deleteMainComment.bind(github) : nullFunc,
      updateOrCreateComment: github ? github.updateOrCreateComment.bind(github) : nullFunc,

      createInlineComment: github ? github.createInlineComment.bind(github) : nullFunc,
      updateInlineComment: github ? github.updateInlineComment.bind(github) : nullFunc,
      deleteInlineComment: github ? github.deleteInlineComment.bind(github) : nullFunc,
      getInlineComments: () => (github ? github.getInlineComments.bind(github) : nullFunc),

      supportsCommenting: () => (github ? github.supportsCommenting.bind(github) : nullFunc),
      supportsInlineComments: () => (github ? github.supportsInlineComments.bind(github) : nullFunc),

      updateStatus: () => (github ? github.supportsInlineComments.bind(github) : nullFunc),

      getPlatformDSLRepresentation: async () => {
        return {
          ...githubEvent,
          api: github && github.api.getExternalAPI(),
          utils,
        }
      },
      getPlatformGitRepresentation: async () => {
        return {} as any
      },
    }
    return platform
  }
}
