import { test, expect } from "@playwright/test";

test.describe("TypeScript Analytics Demo", () => {
	test("should load the dashboard", async ({ page }) => {
		await page.goto("/");

		// Check that the page loads correctly
		await expect(page).toHaveTitle(/TypeScript Analytics Demo/);
		await expect(page.locator("h1")).toContainText("TypeScript Analytics Demo");

		// The dashboard fetches its data from server actions on load
		await expect(page.locator(".dashboard")).toBeVisible({ timeout: 15000 });
	});

	test("should serve analytics data through server actions", async ({ request, baseURL }) => {
		const dateRange = {
			start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
			end: new Date().toISOString(),
		};

		// calculateMetric lives in src/actions/analytics.server.ts -> /api/actions/analytics/calculateMetric
		const metricResponse = await request.post(`${baseURL}/api/actions/analytics/calculateMetric`, {
			data: ["user_count_daily", dateRange],
		});
		expect(metricResponse.ok()).toBeTruthy();

		// generateTimeSeries lives in src/actions/data-generator.server.ts
		const timeSeriesResponse = await request.post(`${baseURL}/api/actions/data-generator/generateTimeSeries`, {
			data: ["revenue", dateRange, "daily"],
		});
		expect(timeSeriesResponse.ok()).toBeTruthy();

		const timeSeries = await timeSeriesResponse.json();
		expect(Array.isArray(timeSeries)).toBe(true);
		expect(timeSeries.length).toBeGreaterThan(0);
		expect(timeSeries[0]).toHaveProperty("timestamp");
		expect(timeSeries[0]).toHaveProperty("value");
	});

	test("should expose OpenAPI spec", async ({ request, baseURL }) => {
		const response = await request.get(`${baseURL}/api/openapi.json`);
		expect(response.ok()).toBeTruthy();

		const spec = await response.json();
		expect(spec.openapi).toBe("3.0.3");
		expect(spec.info.title).toBe("TypeScript Analytics Demo API");
		expect(spec.paths).toHaveProperty("/api/actions/analytics/calculateMetric");
	});
});
