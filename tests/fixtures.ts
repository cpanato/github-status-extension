export function summary(status = "operational", indicator = "none") {
  return {
    status: { indicator, description: "Provider description" },
    components: [
      { id: "api", name: "API Requests", status },
      { id: "git", name: "Git Operations", status: "operational" },
    ],
    incidents: [],
    scheduled_maintenances: [],
  };
}
