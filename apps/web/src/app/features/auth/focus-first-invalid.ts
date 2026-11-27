import { afterNextRender, type Injector } from '@angular/core';

/** After the next render, focuses the first invalid control inside `root`. */
export function focusFirstInvalid(root: HTMLElement, injector: Injector): void {
  afterNextRender(
    () => root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    { injector },
  );
}
