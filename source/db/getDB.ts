import { jsonDatabase } from "./json"
import { mongoDatabase } from "./mongo"

import { DatabaseAdaptor } from "."

const isJest = typeof jest !== "undefined"

const getDatabaseForEnv = (env: any): DatabaseAdaptor | null => {
  if (env.DATABASE_JSON_FILE || isJest) {
    const json = jsonDatabase(env.DATABASE_JSON_FILE)
    json.setup()
    return json
  }

  if (env.MONGODB_URI) {
    if (!isJest) {
      mongoDatabase.setup()
    }
    return mongoDatabase
  }

  return null
}

let db: DatabaseAdaptor | null = null
/** Gets the Current DB for this runtime environment */
export const getDB = () => {
  if (!db) {
    db = getDatabaseForEnv(process.env)
  }

  if (!db) {
    throw new Error("No default DB was set up")
  }

  return db
}
