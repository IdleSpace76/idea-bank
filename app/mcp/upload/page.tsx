import {getOwnerSession} from "@/auth";
import {mcpSettings} from "@/lib/mcp-auth";
import {notFound} from "next/navigation";
import {AgentUploadForm} from "@/components/agent-upload-form";
export const dynamic="force-dynamic";
export default async function Page(){try{mcpSettings();}catch{notFound();}return <AgentUploadForm authenticated={!!await getOwnerSession()} />;}
