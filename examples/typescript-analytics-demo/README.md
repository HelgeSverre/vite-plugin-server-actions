# TypeScript Analytics Demo

This example demonstrates advanced TypeScript features with Vite Server Actions through a practical analytics dashboard.

## Features Demonstrated

### TypeScript Patterns

1. **Branded Types** - Type-safe IDs that prevent mixing different entity types
2. **Template Literal Types** - Dynamic type creation for metric names
3. **Conditional Types** - Return different types based on input types
4. **Intersection Types** - Combining multiple types
5. **Mapped Types** - Transform object types programmatically
6. **Discriminated Unions** - Type-safe event handling
7. **Generic Constraints** - Type-safe data transformers
8. **Type Inference** - Automatic type detection from usage

### Visual Components

- **Metrics Grid** - Display KPIs with type-safe data
- **Time Series Chart** - Interactive data visualization
- **Type Feature Cards** - Educational tooltips explaining TypeScript features

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Type check
npm run typecheck
```

## Project Structure

```
src/
├── types/              # Shared TypeScript type definitions
│   ├── branded.ts      # Branded type utilities
│   ├── analytics.ts    # Analytics domain types
│   └── analytics-types.ts
├── actions/            # Server-side functions (.server.ts)
│   ├── analytics.server.ts       # Analytics calculations
│   ├── analytics-all.server.ts
│   ├── data-generator.server.ts  # Synthetic data generation
│   ├── metrics.server.ts
│   ├── simple-analytics.server.ts
│   └── simple.server.ts
├── components/         # React components
│   ├── Dashboard.tsx   # Main dashboard container
│   ├── SimpleDashboard.tsx
│   ├── MetricsGrid.tsx # KPI display grid
│   ├── TimeSeriesChart.tsx      # Chart component
│   └── TypeFeatureCard.tsx      # Educational cards
└── styles/            # CSS styles
```

## TypeScript Features Explained

### Branded Types

```typescript
type UserId = string & { __brand: "UserId" };
type OrderId = string & { __brand: "OrderId" };
```

Prevents accidentally using a UserId where an OrderId is expected.

### Template Literal Types

```typescript
type MetricName = `${Entity}_${Metric}_${Timeframe}`;
// Results in: "user_count_daily" | "order_revenue_weekly" | ...
```

Creates type-safe metric names from string combinations.

### Conditional Types

```typescript
type MetricValue<T> = T extends `${infer E}_count_${infer TF}`
  ? number
  : T extends `${infer E}_revenue_${infer TF}`
    ? { amount: number; currency: string }
    : never;
```

Returns different types based on the metric name pattern.

### Mapped Types

```typescript
type Aggregation<T> = {
  [K in keyof T as `${string & K}_sum`]?: number;
} & {
  [K in keyof T as `${string & K}_avg`]?: number;
};
```

Transforms object types to create new shapes.

## API Documentation

Visit `/api/docs` when running the development server to see the interactive API documentation generated from the Zod schemas attached to the server actions.

## Learn More

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Vite Server Actions](https://github.com/HelgeSverre/vite-plugin-server-actions)
