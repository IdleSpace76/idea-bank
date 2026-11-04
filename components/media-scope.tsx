"use client";
import { createContext, useContext } from "react";
export const MediaScope = createContext<string | undefined>(undefined);
export const useMediaScope = () => useContext(MediaScope);
