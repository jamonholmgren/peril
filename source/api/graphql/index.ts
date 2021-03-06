import { connectionArgs, connectionDefinitions, connectionFromArray, pageInfoType } from "graphql-relay-tools"
import { combineResolvers } from "graphql-resolvers"
import { makeExecutableSchema } from "graphql-tools"
import { Date, JSON } from "graphql-tools-types"

import { GitHubInstallation } from "../../db"
import { getDB } from "../../db/getDB"
import { MongoDB } from "../../db/mongo"
import {
  getRecordedWebhooksForInstallation,
  setInstallationToRecord,
  wipeAllRecordedWebhooks,
} from "../../plugins/utils/recordWebhookWithRequest"
import { GraphQLContext } from "../api"
import { getDetailsFromPerilJWT } from "../auth/generate"
import { gql } from "./gql"

const { connectionType: partialConnection } = connectionDefinitions({ name: "PartialInstallation" })
const { connectionType: installationConnection } = connectionDefinitions({ name: "Installation" })
const { connectionType: recordedWebhookConnection } = connectionDefinitions({ name: "RecordedWebhook" })

const schemaSDL = gql`
  # Basically a way to say this is going to be untyped data (it's normally user input)
  scalar JSON
  scalar Date

  # An installation of Peril which isn't set up yet
  type PartialInstallation {
    # The MongoDB ID
    id: String!
    # The installation ID, in the real sense
    iID: Int!
    # The name of the installation owner
    login: String!
    # The URL for an image representing the installation owner
    avatarURL: String!
  }

  # An installation of Peril, ideally not too tightly tied to GH
  type Installation {
    # The MongoDB ID
    id: String!
    # The installation ID, in the real sense
    iID: Int!
    # The path to the Dangerfile
    perilSettingsJSONURL: String!
    # The name of a user/org which the installation is attached to
    login: String!
    # The URL for an image representing the installation owner
    avatarURL: String!
    # A set of per repo rules
    repos: JSON!
    # Rules that are for all repos
    rules: JSON!
    # Scheduled tasks to run repeatedly
    scheduler: JSON!
    # Installation settings, for example ignored repos
    settings: JSON!
    # Tasks which you can schedule to run in the future
    tasks: JSON!
    # Tasks which you can schedule to run in the future
    webhooks${connectionArgs()}: RecordedWebhookConnection
  }

  # Someone logged in to the API, all user data is stored inside the JWT
  type User {
    # Display name
    name: String!
    # Use this to show an avatar
    avatarURL: String!
    # The installations that a user has access to
    installations${connectionArgs()}: InstallationConnection
    # The installations that a user has access to, but hasn't been set up yet
    installationsToSetUp${connectionArgs()}: PartialInstallationConnection
  }

  # A stored webhook from GitHub so we can re-send it in the future
  type RecordedWebhook {
    # Installation ID
    iID: Int!
    # A string like 'pull_request.closed' to show the preview
    event: String!
    # The webhook JSON, it will not be included in collections of webhooks
    json: JSON
    # The UUID from GitHub for the webhook
    eventID: String!
    # The time when the recording was made
    createdAt: Date!
  }

  # Root
  type Query {
    # The logged in user
    me: User
    # Get information about an installation
    installation(iID: Int!): Installation
  }

  type Mutation {
    # Building this out incrementally, but basically this provides
    # the ability to set the URL that Peril should grab data from
    editInstallation(iID: Int!, perilSettingsJSONURL: String!): Installation
    # Sets the installation to record webhooks for the next 5m
    makeInstallationRecord(iID: Int!): Installation
  }
`

// A any'd resolver type, with the right context
type Resolver = (obj: any, params: any, context: GraphQLContext) => Promise<any>

// A combined resolver that checks for auth before running the resolver
const authD = (resolver: Resolver) => combineResolvers(isAuthenticated, resolver)
const isAuthenticated = (_: any, __: any, context: GraphQLContext) => {
  if (!context.jwt) {
    return new Error("Not authenticated")
  }
  return undefined
}

const getUserInstallations = async (jwt: string) => {
  const decodedJWT = await getDetailsFromPerilJWT(jwt)
  const db = getDB() as MongoDB
  return await db.getInstallations(decodedJWT.iss.map(i => parseInt(i, 10)))
}

const resolvers = {
  // Let's graphql-tools-types handle the user-data and just puts the whole obj in response
  JSON: JSON({ name: "Any" }),
  Date: Date({ name: "JSDate" }),

  User: {
    // Installations with useful data
    installations: authD(async (_: any, args: any, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return connectionFromArray(installations.filter(i => i.perilSettingsJSONURL), args)
    }),
    // Ready to set up installations with a subset of the data
    installationsToSetUp: authD(async (_: any, args: any, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return connectionFromArray(installations.filter(i => !i.perilSettingsJSONURL), args)
    }),
    // Rename it from GH's JSON to camelCase
    avatarURL: ({ avatar_url }: { avatar_url: string }) => avatar_url,
  },

  Installation: {
    webhooks: authD(async (parent: Partial<GitHubInstallation>, args: any, _: GraphQLContext) => {
      const installationID = parent.iID!
      const webhooks = await getRecordedWebhooksForInstallation(installationID)
      return connectionFromArray(webhooks, args)
    }),
  },

  Query: {
    // Extract metadata from the JWT
    me: authD(async (_: any, __: any, context: GraphQLContext) => {
      const decodedJWT = await getDetailsFromPerilJWT(context.jwt)
      return decodedJWT.data.user
    }),

    installation: authD(async (_: any, params: { iID: number }, context: GraphQLContext) => {
      const installations = await getUserInstallations(context.jwt)
      return installations.find(i => i.iID === params.iID)
    }),
  },

  Mutation: {
    editInstallation: authD(async (_: any, params: any, context: GraphQLContext) => {
      const decodedJWT = await getDetailsFromPerilJWT(context.jwt)
      const installationID = String(params.iID)

      // Check the installation's ID is included inside the signed JWT, to verify access
      if (!decodedJWT.iss.includes(installationID)) {
        throw new Error(`You don't have access to this installation`)
      }

      // Save the changes, then trigger an update from the new repo
      const db = getDB() as MongoDB
      const updatedInstallation = await db.saveInstallation(params)
      await db.updateInstallation(updatedInstallation.iID)
      return updatedInstallation
    }),

    makeInstallationRecord: authD(async (_: any, params: any, context: GraphQLContext) => {
      const decodedJWT = await getDetailsFromPerilJWT(context.jwt)
      const installationID = String(params.iID)

      // Check the installation's ID is included inside the signed JWT, to verify access
      if (!decodedJWT.iss.includes(installationID)) {
        throw new Error(`You don't have access to this installation`)
      }

      await wipeAllRecordedWebhooks(params.iID)
      await setInstallationToRecord(params.iID)

      // Return the modified installation
      const installations = await getUserInstallations(context.jwt)
      return installations.find(i => i.iID === params.iID)
    }),
  },
}

export const schema = makeExecutableSchema<GraphQLContext>({
  typeDefs: [schemaSDL, pageInfoType, installationConnection, partialConnection, recordedWebhookConnection],
  resolvers,
})
