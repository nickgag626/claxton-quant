import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";

export const DataLagWarning = () => {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-2 px-3 py-2 bg-bloomberg-amber/10 border border-bloomberg-amber/30 rounded-md"
    >
      <AlertTriangle className="w-4 h-4 text-bloomberg-amber shrink-0" />
      <p className="text-xs text-bloomberg-amber">
        <span className="font-semibold">Paper trading</span> Currently set to use Sandbox trading environment based on
        actual market data.
      </p>
    </motion.div>
  );
};
