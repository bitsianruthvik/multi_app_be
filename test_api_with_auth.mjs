const API_HOST = "http://localhost:4000";

async function testAPIWithAuth() {
  try {
    // Step 1: Login to get token
    console.log("Step 1: Logging in...");
    const loginResponse = await fetch(
      `${API_HOST}/api/pharma_labs/sales_control/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "pharma@gmail.com",
          password: "password123",
        }),
      }
    );

    const loginData = await loginResponse.json();
    console.log("Login status:", loginResponse.status);

    if (!loginData.token) {
      console.error("Failed to get token:", loginData);
      return;
    }

    const token = loginData.token;
    console.log("✅ Got token");

    // Step 2: Query base_resource with token
    console.log("\nStep 2: Querying base_resource...");
    console.log("URL:", `${API_HOST}/api/query/v1/base_resource`);

    const response = await fetch(`${API_HOST}/api/query/v1/base_resource`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
      const uniqueMedicines = [...new Set(medicines)];
      console.log("All medicines:", medicines);
      console.log("Unique medicines:", uniqueMedicines);
      console.log("Count:", uniqueMedicines.length);
    }
  } catch (error) {
    console.error("Test error:", error);
  }
}

testAPIWithAuth();
