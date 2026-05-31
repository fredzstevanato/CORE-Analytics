CREATE TABLE IF NOT EXISTS "SyncNode" (
  "id" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "displayName" TEXT,
  "role" TEXT NOT NULL DEFAULT 'NODE',
  "baseUrl" TEXT,
  "metadata" JSONB,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SyncNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SyncNode_nodeId_key"
  ON "SyncNode"("nodeId");

CREATE INDEX IF NOT EXISTS "SyncNode_role_updatedAt_idx"
  ON "SyncNode"("role", "updatedAt");

CREATE TABLE IF NOT EXISTS "SyncPackage" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "sourceNodeId" TEXT NOT NULL,
  "sourceNodeName" TEXT,
  "caseId" TEXT,
  "evidenceId" TEXT,
  "extractionId" TEXT,
  "caseNumber" TEXT,
  "payloadHash" TEXT NOT NULL,
  "itemCounts" JSONB,
  "errorMessage" TEXT,
  "exportedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "importedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SyncPackage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SyncPackage_packageId_key"
  ON "SyncPackage"("packageId");

CREATE INDEX IF NOT EXISTS "SyncPackage_direction_status_createdAt_idx"
  ON "SyncPackage"("direction", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "SyncPackage_sourceNodeId_createdAt_idx"
  ON "SyncPackage"("sourceNodeId", "createdAt");

CREATE INDEX IF NOT EXISTS "SyncPackage_caseNumber_createdAt_idx"
  ON "SyncPackage"("caseNumber", "createdAt");

CREATE TABLE IF NOT EXISTS "SyncImportLog" (
  "id" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'INFO',
  "entityType" TEXT,
  "sourceEntityId" TEXT,
  "localEntityId" TEXT,
  "action" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SyncImportLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SyncImportLog_packageId_createdAt_idx"
  ON "SyncImportLog"("packageId", "createdAt");

CREATE INDEX IF NOT EXISTS "SyncImportLog_entityType_action_createdAt_idx"
  ON "SyncImportLog"("entityType", "action", "createdAt");

CREATE TABLE IF NOT EXISTS "ExternalEntityMap" (
  "id" TEXT NOT NULL,
  "sourceNodeId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "sourceEntityId" TEXT NOT NULL,
  "localEntityType" TEXT NOT NULL,
  "localEntityId" TEXT NOT NULL,
  "packageId" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExternalEntityMap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalEntityMap_sourceNodeId_entityType_sourceEntityId_key"
  ON "ExternalEntityMap"("sourceNodeId", "entityType", "sourceEntityId");

CREATE INDEX IF NOT EXISTS "ExternalEntityMap_localEntityType_localEntityId_idx"
  ON "ExternalEntityMap"("localEntityType", "localEntityId");

CREATE INDEX IF NOT EXISTS "ExternalEntityMap_packageId_idx"
  ON "ExternalEntityMap"("packageId");
