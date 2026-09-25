import { test } from '@playwright/test';
import { testHistory } from '../../scripts/testHistory';

test('archived history confirms permanent deletion and related chat titles in VS Code', async () => {
  test.setTimeout(180_000);
  await testHistory();
});
