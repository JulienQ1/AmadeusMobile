// Login screen (Manager.cs): the Amadeus credentials from Steins;Gate 0.

import { se } from '../audio/se';
import { vibrate } from '../native/bridge';
import { settings } from '../settings';
import { $ } from './dom';

const LOGIN_ID = 'Salieri';
const PASSWORD = 'MakiseKurisu';
const REMEMBER_KEY = 'amadeus.login';

export function showLogin(onSuccess: (operator: string) => void): void {
  const screen = $('#screen-login');
  const id = $<HTMLInputElement>('#login-id');
  const pass = $<HTMLInputElement>('#login-pass');
  const error = $('#login-error');
  const form = $<HTMLFormElement>('.login-form', screen);

  // After the first successful login the fields are pre-filled: one tap to enter.
  const remembered = localStorage.getItem(REMEMBER_KEY) === '1';
  id.value = remembered ? LOGIN_ID : '';
  pass.value = remembered ? PASSWORD : '';
  error.hidden = true;
  screen.hidden = false;

  form.onsubmit = (e) => {
    e.preventDefault();
    if (id.value === LOGIN_ID && pass.value === PASSWORD) {
      error.hidden = true;
      localStorage.setItem(REMEMBER_KEY, '1');
      se('confirm');
      id.blur();
      pass.blur();
      screen.hidden = true;
      onSuccess(LOGIN_ID);
    } else {
      error.hidden = true;
      void error.offsetWidth; // restart the shake animation
      error.hidden = false;
      se('denied');
      if (settings.get().haptics) vibrate(120);
    }
  };
}
