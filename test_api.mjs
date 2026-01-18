const API_HOST = "http://localhost:4000";

async function testAPI() {
  try {
    console.log("Testing API endpoint...");
    console.log("URL:", `${API_HOST}/api/query/v1/base_resource`);

    const response = await fetch(`${API_HOST}/api/query/v1/base_resource`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: "query",
        resource: "team_documents",
        fields: ["medicines"],
        filters: {},
      }),
    });

    console.log("Status:", response.status);
    console.log("Status Text:", response.statusText);

    const data = await response.json();
    console.log("\nResponse data:");
    console.log(JSON.stringify(data, null, 2));

    if (data.data) {
      console.log("\nExtracted medicines:");
      const medicines = data.data.map((row) => row.medicines).filter(Boolean);
      console.log(medicines);
    }
  } catch (error) {
    console.error("Test error:", error);
  }
}

testAPI();
