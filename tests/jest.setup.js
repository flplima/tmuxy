// Jest setup for E2E tests

// Increase timeout for all tests
jest.setTimeout(60000);

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
