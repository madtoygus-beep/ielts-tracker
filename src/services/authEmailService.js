import { sendPasswordResetEmail as firebaseSendPasswordResetEmail } from 'firebase/auth'
import { auth } from '../firebase'

// P2A email provider boundary.
// New admin-created accounts receive a Firebase password-reset link as their
// account-setup/activation email so the user chooses their own password.
// Existing accounts continue to use the same Firebase password-reset flow.
// If the email provider changes later, keep callers stable and replace only
// the implementation inside this module.

const normalizeEmail = email => String(email || '').trim().toLowerCase()

const requireEmail = email => {
  const cleanEmail = normalizeEmail(email)

  if (!cleanEmail) {
    const error = new Error('A valid email address is required.')
    error.code = 'auth-email/missing-email'
    throw error
  }

  return cleanEmail
}

const firebaseEmailProvider = {
  async sendPasswordSetupLink(email) {
    const cleanEmail = requireEmail(email)
    await firebaseSendPasswordResetEmail(auth, cleanEmail)
  }
}

export async function sendActivationEmail(email) {
  return firebaseEmailProvider.sendPasswordSetupLink(email)
}

export async function sendPasswordResetEmail(email) {
  return firebaseEmailProvider.sendPasswordSetupLink(email)
}
