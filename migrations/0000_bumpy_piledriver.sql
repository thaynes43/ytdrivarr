CREATE TYPE "public"."job_kind" AS ENUM('discovery', 'remediation');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'claimed', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('video', 'music');--> statement-breakpoint
CREATE TYPE "public"."remediation_action" AS ENUM('redownload', 'replace');--> statement-breakpoint
CREATE TYPE "public"."remediation_status" AS ENUM('queued', 'running', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_scope" AS ENUM('all', 'library', 'source');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'ok', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('cron', 'api', 'edit');--> statement-breakpoint
CREATE TYPE "public"."source_audit_action" AS ENUM('create', 'update', 'delete', 'enable', 'disable');--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"player" text DEFAULT 'plex' NOT NULL,
	"media_root" text NOT NULL,
	"library_kind" "media_kind" DEFAULT 'video' NOT NULL,
	"preset_name" text NOT NULL,
	"projection_path" text NOT NULL,
	"working_directory" text DEFAULT '/workdir/' NOT NULL,
	"emit_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"media_kind" "media_kind" DEFAULT 'video' NOT NULL,
	"display_name" text NOT NULL,
	"ref" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT 'api' NOT NULL,
	"caps_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"entry_key" text NOT NULL,
	"display_name" text NOT NULL,
	"download_ref" text NOT NULL,
	"preset" text NOT NULL,
	"chip" text,
	"overrides" jsonb,
	"ytdl_options" jsonb,
	"assets" jsonb,
	"season_number" integer,
	"episode_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_entries_source_key_uq" UNIQUE("source_id","entry_key")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "run_scope" NOT NULL,
	"scope_ref" uuid,
	"trigger" "run_trigger" NOT NULL,
	"provider_id" text,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"telemetry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log_excerpt" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "remediation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"entry_key" text NOT NULL,
	"action" "remediation_action" NOT NULL,
	"status" "remediation_status" DEFAULT 'queued' NOT NULL,
	"requested_by" text DEFAULT 'api' NOT NULL,
	"provider_run_id" uuid,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"provider_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_state_ns_key_uq" UNIQUE("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "source_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"action" "source_audit_action" NOT NULL,
	"api_key_id" text DEFAULT 'api' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_entries" ADD CONSTRAINT "subscription_entries_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_jobs" ADD CONSTRAINT "remediation_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_library_id_idx" ON "sources" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "subscription_entries_source_id_idx" ON "subscription_entries" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "remediation_jobs_source_id_idx" ON "remediation_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_audit_source_id_idx" ON "source_audit" USING btree ("source_id");