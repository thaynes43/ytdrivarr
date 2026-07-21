ALTER TABLE "libraries" ADD COLUMN "credential_path" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;