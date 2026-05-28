import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Toast({ message, type }) {
  return (
    <AnimatePresence>
      <motion.div
        className={`toast toast-${type}`}
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
      >
        {type === 'error' ? '\u2717' : '\u2713'} {message}
      </motion.div>
    </AnimatePresence>
  );
}
