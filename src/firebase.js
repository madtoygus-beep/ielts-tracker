import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFirestore } from "firebase/firestore"

const firebaseConfig = {
  apiKey: "AIzaSyBuy-DyA5cHqoDx4TSgGIqUJSShuvOKN4k",
  authDomain: "maxima-tracker.firebaseapp.com",
  projectId: "maxima-tracker",
  storageBucket: "maxima-tracker.firebasestorage.app",
  messagingSenderId: "3837298984",
  appId: "1:3837298984:web:4f87f66079f3eba572e81d"
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)