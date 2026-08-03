-- CreateIndex
CREATE INDEX "WatchlistEntry_nameTokens_idx" ON "WatchlistEntry" USING GIN ("nameTokens" array_ops);

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistEntry_listName_sourceRef_key" ON "WatchlistEntry"("listName", "sourceRef");

