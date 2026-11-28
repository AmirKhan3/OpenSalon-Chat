import { Badge } from "@/components/ui/badge";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Waiting for pre-pay", variant: "outline" },
  booked: { label: "Booked", variant: "default" },
  confirmed: { label: "Confirmed", variant: "secondary" },
  in_progress: { label: "In progress", variant: "outline" },
  completed: { label: "Completed", variant: "secondary" },
  cancelled: { label: "Cancelled", variant: "destructive" },
  no_show: { label: "No show", variant: "destructive" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || { label: status, variant: "outline" as const };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
