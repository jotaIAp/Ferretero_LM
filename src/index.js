const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const http = require('http'); // <--- PARA RENDER

// 1. Validar configuraciones
if (!process.env.TELEGRAM_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ Error crítico: Faltan configuraciones en el archivo .env");
    process.exit(1);
}

console.log("✅ Configuraciones cargadas correctamente");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// 2. Función maestra para formato moneda
const fmt = (n) => `S/. ${parseFloat(n || 0).toFixed(2)}`;

// 3. Función para formatear números
const formatearNumero = (valor) => {
    if (isNaN(valor)) return 0;
    return parseFloat(parseFloat(valor).toFixed(2));
};

// 4. Función para calcular precio sugerido por cantidad
function calcularPrecioSugerido(precioOriginal, cantidad, costo) {
    const MARGEN_GANANCIA = 1.30;
    let descuentoVolumen = 0;
    
    if (cantidad >= 100) {
        descuentoVolumen = 0.25;
    } else if (cantidad >= 50) {
        descuentoVolumen = 0.20;
    } else if (cantidad >= 25) {
        descuentoVolumen = 0.15;
    } else if (cantidad >= 10) {
        descuentoVolumen = 0.10;
    } else if (cantidad >= 5) {
        descuentoVolumen = 0.05;
    }
    
    let precioSugerido = (costo * MARGEN_GANANCIA) * (1 - descuentoVolumen);
    
    if (precioSugerido < costo) {
        precioSugerido = costo * 1.05;
    }
    if (precioSugerido > precioOriginal) {
        precioSugerido = precioOriginal * 0.95;
    }
    
    return formatearNumero(precioSugerido);
}

// 5. Gestión de estados
const estados = {};
function getEstado(userId) {
    if (!estados[userId]) {
        estados[userId] = { 
            esperando: null, 
            resultadosBusqueda: null, 
            carrito: [], 
            autenticado: false, 
            rol: null, 
            temp: null,
            paginaActual: 1,
            totalPaginas: 1,
            descuentoGlobal: null
        };
    }
    return estados[userId];
}

// 6. Función para limpiar completamente el estado del carrito
function limpiarCarrito(estado) {
    estado.carrito = [];
    estado.resultadosBusqueda = null;
    estado.esperando = null;
    estado.temp = null;
    estado.descuentoGlobal = null;
}

// 7. Función para mostrar productos
function mostrarProducto(producto, index = null) {
    const prefix = index !== null ? `${index + 1}. ` : '';
    const nombre = producto.nombre || 'Sin nombre';
    const marca = producto.marca || 'Sin marca';
    const precioVenta = fmt(producto.precio_venta || 0);
    const precioCosto = fmt(producto.precio_costo || 0);
    const stock = producto.stock || 0;
    
    return `${prefix}*${nombre}* (${marca})\n   💰 Venta: ${precioVenta} | Costo: ${precioCosto} | 📦 Stock: *${stock}*\n`;
}

// 8. Función de paginación
function mostrarPaginaProductos(ctx, productos, pagina, esBusqueda = false) {
    const itemsPorPagina = 5;
    const totalPaginas = Math.ceil(productos.length / itemsPorPagina);
    const inicio = (pagina - 1) * itemsPorPagina;
    const fin = Math.min(inicio + itemsPorPagina, productos.length);
    const paginaProductos = productos.slice(inicio, fin);
    
    let respuesta = "📋 **PRODUCTOS DISPONIBLES**\n\n";
    paginaProductos.forEach((prod, index) => {
        respuesta += mostrarProducto(prod, inicio + index);
    });
    
    respuesta += `\n📄 Página ${pagina} de ${totalPaginas}\n`;
    respuesta += `Total: ${productos.length} productos\n\n`;
    
    if (esBusqueda) {
        respuesta += "✏️ Escribe el número del producto y cantidad:\n";
        respuesta += "Ejemplo: `1, 3` (producto 1, cantidad 3)\n";
        respuesta += "Para precio personalizado: `1, 3, precio 15.50`\n";
        respuesta += "Para descuento por unidad: `1, 3, desc 10` (10% por unidad)\n";
        respuesta += "Para descuento al total: `1, 3, desc 2` (S/.2 al total)\n";
        respuesta += "Para precio sugerido: `1, 3, sugerido` (precio por cantidad)";
    } else {
        respuesta += "🔢 **¿Vender artículo?** Escribe su número y cantidad (Ej: `2, 5`):";
    }
    
    const keyboard = {
        inline_keyboard: []
    };
    
    if (pagina > 1) {
        keyboard.inline_keyboard.push([{ text: "◀️ Anterior", callback_data: `pagina_${pagina-1}` }]);
    }
    if (pagina < totalPaginas) {
        keyboard.inline_keyboard.push([{ text: "Siguiente ▶️", callback_data: `pagina_${pagina+1}` }]);
    }
    
    const estado = getEstado(ctx.from.id);
    estado.paginaActual = pagina;
    estado.totalPaginas = totalPaginas;
    
    return ctx.reply(respuesta, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// 9. Función para mostrar carrito
function mostrarCarrito(ctx, estado) {
    let r = "🛒 **Tu Carrito Actual:**\n\n";
    let total = 0;
    let totalOriginal = 0;
    let totalAhorro = 0;
    
    if (!estado.carrito || estado.carrito.length === 0) {
        return ctx.reply("🛒 El carrito está vacío.");
    }
    
    estado.carrito.forEach((item, index) => {
        const sub = item.precio * item.cantidad;
        const subOriginal = (item.precioOriginal || item.precio) * item.cantidad;
        total += sub;
        totalOriginal += subOriginal;
        totalAhorro += (subOriginal - sub);
        
        r += `${index + 1}. ${item.nombre} x${item.cantidad}`;
        if (item.precioSugerido) {
            r += ` 📊 Precio sugerido: ${fmt(item.precioSugerido)}`;
        }
        r += ` — ${fmt(sub)}`;
        if (item.descuentoPorcentaje > 0) {
            r += ` (${item.descuentoPorcentaje}% desc por unidad)`;
        }
        if (item.descuentoFijo > 0) {
            r += ` (S/. ${item.descuentoFijo.toFixed(2)} desc al total)`;
        }
        if (item.precioPersonalizado) {
            r += ` ⚠️ Precio personalizado: ${fmt(item.precioPersonalizado)}`;
        }
        r += `\n`;
    });
    
    r += `\n💰 **Total General: ${fmt(total)}**`;
    if (totalAhorro > 0) {
        r += `\n💵 **Ahorro total: ${fmt(totalAhorro)}**`;
        r += `\n📊 **Total sin descuentos: ${fmt(totalOriginal)}**`;
    }
    r += `\n\n**Selecciona una opción:**`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "✏️ Editar Precio", callback_data: "editar_precio_carrito" }],
            [{ text: "🏷️ Aplicar Descuento Global", callback_data: "descuento_global" }],
            [{ text: "💵 Efectivo", callback_data: "pago_Efectivo" }, { text: "💳 Tarjeta", callback_data: "pago_Tarjeta" }],
            [{ text: "📱 Transferencia", callback_data: "pago_Transferencia" }],
            [{ text: "🔙 Volver a buscar", callback_data: "volver_busqueda" }],
            [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
        ]
    };
    
    return ctx.reply(r, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// 10. Función para mostrar el menú principal con botones
function mostrarMenuPrincipal(ctx) {
    const estado = getEstado(ctx.from.id);
    
    // 🗑️ LIMPIAR CARRITO AL VOLVER AL MENÚ PRINCIPAL
    if (estado.autenticado) {
        limpiarCarrito(estado);
    }
    
    let mensaje = "🏪 **Sistema POS Ferretero**\n\n";
    
    if (!estado.autenticado) {
        mensaje += "🔐 **ACCESO RESTRINGIDO**\n";
        mensaje += "Por favor, introduce tu PIN de acceso.\n\n";
        mensaje += "⚠️ *Este sistema es de uso exclusivo para personal autorizado.*";
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔐 Iniciar Sesión", callback_data: "iniciar_sesion" }]
            ]
        };
        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
    }
    
    mensaje += `👋 Bienvenido, *${estado.rol}*\n\n`;
    mensaje += "📌 **Selecciona una opción:**";
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔍 Buscar Productos", callback_data: "buscar_productos" }],
            [{ text: "📊 Ver Inventario", callback_data: "ver_inventario" }],
            [{ text: "🛒 Ver Carrito", callback_data: "ver_carrito" }],
            [{ text: "🗑️ Vaciar Carrito", callback_data: "vaciar_carrito" }]
        ]
    };
    
    if (estado.rol === 'ADMINISTRADOR') {
        keyboard.inline_keyboard.push([
            { text: "➕ Agregar Producto", callback_data: "agregar_producto" },
            { text: "✏️ Editar Producto", callback_data: "editar_producto" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "💰 Ganancias", callback_data: "ver_ganancias" },
            { text: "🔔 Alertas Stock", callback_data: "ver_alertas" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "📦 Registrar Compra", callback_data: "registrar_compra" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "📊 Reporte Movimientos", callback_data: "reporte_movimientos" },
            { text: "📈 Resumen Inventario", callback_data: "resumen_inventario" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "🔍 Movimientos x Producto", callback_data: "movimientos_producto" }
        ]);
    }
    
    keyboard.inline_keyboard.push([{ text: "❌ Cerrar Sesión", callback_data: "cerrar_sesion" }]);
    
    return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// 11. FUNCIONES DE REPORTES
async function mostrarReporteMovimientos(ctx) {
    try {
        const { data: movimientos, error } = await supabase
            .from('movimientos_inventario')
            .select(`
                *,
                productos (
                    nombre,
                    marca
                )
            `)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error("Error en reporte de movimientos:", error);
            return ctx.reply("❌ Error al generar el reporte.");
        }

        if (!movimientos || movimientos.length === 0) {
            return ctx.reply(
                "📊 **REPORTE DE MOVIMIENTOS**\n\n" +
                "No hay movimientos registrados aún.",
                { parse_mode: 'Markdown' }
            );
        }

        let mensaje = "📊 **REPORTE DE MOVIMIENTOS**\n";
        mensaje += `📅 _Últimos ${movimientos.length} movimientos_\n`;
        mensaje += `📆 Fecha: ${new Date().toLocaleDateString()}\n`;
        mensaje += `-----------------------------------\n\n`;

        movimientos.forEach(m => {
            const tipoIcono = m.tipo_movimiento === 'ENTRADA' ? '📥' : '📤';
            const signo = m.tipo_movimiento === 'ENTRADA' ? '+' : '-';
            const nombreProducto = m.productos?.nombre || 'Producto eliminado';
            
            mensaje += `${tipoIcono} *${m.tipo_movimiento}*\n`;
            mensaje += `📦 ${nombreProducto}\n`;
            mensaje += `🔢 Cantidad: ${signo}${m.cantidad}\n`;
            mensaje += `📊 Stock: ${m.stock_anterior} → ${m.stock_nuevo}\n`;
            mensaje += `📝 Motivo: ${m.motivo || 'N/A'}\n`;
            mensaje += `👤 Usuario: ${m.usuario || 'Sistema'}\n`;
            mensaje += `🕐 ${new Date(m.created_at).toLocaleString()}\n`;
            mensaje += `-----------------------------------\n`;
        });

        const keyboard = {
            inline_keyboard: [
                [{ text: "📊 Ver más", callback_data: "reporte_movimientos_mas" }],
                [{ text: "📈 Resumen", callback_data: "resumen_inventario" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error:", error);
        return ctx.reply("❌ Error al generar el reporte.");
    }
}

async function mostrarResumenInventario(ctx) {
    ctx.reply("📈 Generando resumen de inventario...");
    
    try {
        const { data: stats, error: statsError } = await supabase
            .from('productos')
            .select('*');

        if (statsError) {
            console.error("Error en resumen:", statsError);
            return ctx.reply("❌ Error al generar el resumen.");
        }

        const { data: criticos, error: criticosError } = await supabase
            .from('productos')
            .select('*')
            .lt('stock', 5)
            .order('stock', { ascending: true });

        const inicioHoy = new Date(); 
        inicioHoy.setHours(0,0,0,0);
        const finHoy = new Date(); 
        finHoy.setHours(23,59,59,999);

        const { data: movimientosHoy, error: movError } = await supabase
            .from('movimientos_inventario')
            .select('tipo_movimiento, cantidad')
            .gte('created_at', inicioHoy.toISOString())
            .lte('created_at', finHoy.toISOString());

        let totalProductos = stats?.length || 0;
        let totalStock = 0;
        let valorInventario = 0;
        let valorVenta = 0;

        if (stats) {
            stats.forEach(p => {
                totalStock += p.stock || 0;
                valorInventario += (p.precio_costo || 0) * (p.stock || 0);
                valorVenta += (p.precio_venta || 0) * (p.stock || 0);
            });
        }

        let entradasHoy = 0;
        let salidasHoy = 0;
        if (movimientosHoy) {
            movimientosHoy.forEach(m => {
                if (m.tipo_movimiento === 'ENTRADA') entradasHoy += m.cantidad;
                else if (m.tipo_movimiento === 'SALIDA') salidasHoy += m.cantidad;
            });
        }

        let mensaje = "📈 **RESUMEN DE INVENTARIO**\n";
        mensaje += `📅 _${new Date().toLocaleDateString()}_\n`;
        mensaje += `-----------------------------------\n\n`;
        mensaje += `📦 **Totales Generales:**\n`;
        mensaje += `• Productos únicos: ${totalProductos}\n`;
        mensaje += `• Unidades en stock: ${totalStock}\n`;
        mensaje += `💰 Valor de inventario: ${fmt(valorInventario)}\n`;
        mensaje += `💵 Valor de venta: ${fmt(valorVenta)}\n\n`;
        
        mensaje += `📊 **Movimientos de Hoy:**\n`;
        mensaje += `• 📥 Entradas: ${entradasHoy} unidades\n`;
        mensaje += `• 📤 Salidas: ${salidasHoy} unidades\n\n`;

        if (criticos && criticos.length > 0) {
            mensaje += `⚠️ **Productos con stock bajo (< 5):**\n`;
            criticos.slice(0, 10).forEach(p => {
                mensaje += `• ${p.nombre}: ${p.stock} unidades\n`;
            });
            if (criticos.length > 10) {
                mensaje += `... y ${criticos.length - 10} más\n`;
            }
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: "📊 Ver Movimientos", callback_data: "reporte_movimientos" }],
                [{ text: "📥 Registrar Compra", callback_data: "registrar_compra" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error:", error);
        return ctx.reply("❌ Error al generar el resumen.");
    }
}

async function mostrarMovimientosProducto(ctx, productoNombre) {
    try {
        const { data: productos, error: searchError } = await supabase
            .from('productos')
            .select('id, nombre, marca')
            .ilike('nombre', `%${productoNombre}%`)
            .limit(1);

        if (searchError || !productos || productos.length === 0) {
            return ctx.reply("❌ Producto no encontrado.");
        }

        const producto = productos[0];

        const { data: movimientos, error: movError } = await supabase
            .from('movimientos_inventario')
            .select('*')
            .eq('producto_id', producto.id)
            .order('created_at', { ascending: false })
            .limit(30);

        if (movError) {
            console.error("Error:", movError);
            return ctx.reply("❌ Error al obtener los movimientos.");
        }

        let mensaje = `📊 **MOVIMIENTOS DE PRODUCTO**\n`;
        mensaje += `📦 *${producto.nombre}* (${producto.marca})\n`;
        mensaje += `-----------------------------------\n\n`;

        if (!movimientos || movimientos.length === 0) {
            mensaje += "Este producto no tiene movimientos registrados.";
        } else {
            movimientos.forEach(m => {
                const tipoIcono = m.tipo_movimiento === 'ENTRADA' ? '📥' : '📤';
                const signo = m.tipo_movimiento === 'ENTRADA' ? '+' : '-';
                mensaje += `${tipoIcono} *${m.tipo_movimiento}*\n`;
                mensaje += `Cantidad: ${signo}${m.cantidad}\n`;
                mensaje += `Stock: ${m.stock_anterior} → ${m.stock_nuevo}\n`;
                mensaje += `Motivo: ${m.motivo || 'N/A'}\n`;
                mensaje += `🕐 ${new Date(m.created_at).toLocaleString()}\n`;
                mensaje += `-----------------------------------\n`;
            });
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: "🔍 Buscar otro", callback_data: "movimientos_producto" }],
                [{ text: "📊 Resumen General", callback_data: "resumen_inventario" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };

        const estado = getEstado(ctx.from.id);
        estado.esperando = null;

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error:", error);
        return ctx.reply("❌ Error al obtener los movimientos.");
    }
}

// ==========================================
// COMANDOS
// ==========================================

bot.command('start', (ctx) => {
    const estado = getEstado(ctx.from.id);
    
    if (estado.autenticado) {
        limpiarCarrito(estado);
        return mostrarMenuPrincipal(ctx);
    }
    
    estado.esperando = 'pin';
    estado.carrito = [];
    estado.resultadosBusqueda = null;
    estado.autenticado = false;
    estado.rol = null;
    estado.temp = null;
    estado.paginaActual = 1;
    
    mostrarMenuPrincipal(ctx);
});

bot.command('menu', (ctx) => {
    const estado = getEstado(ctx.from.id);
    
    if (!estado.autenticado) {
        return ctx.reply("⚠️ Por favor ejecuta /start para ingresar al sistema.");
    }
    
    limpiarCarrito(estado);
    mostrarMenuPrincipal(ctx);
});

// ==========================================
// 🧠 PROCESAMIENTO CENTRAL DE TEXTO
// ==========================================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const texto = ctx.message.text.trim();
    const estado = getEstado(userId);

    // CONTROL DE PIN
    if (estado.esperando === 'pin') {
        if (texto === '0316') {
            estado.autenticado = true;
            estado.rol = 'ADMINISTRADOR';
            estado.esperando = null;
            await ctx.reply("👑 **Modo ADMINISTRADOR iniciado.**");
            return mostrarMenuPrincipal(ctx);
        } else if (texto === '1234') {
            estado.autenticado = true;
            estado.rol = 'VENDEDOR';
            estado.esperando = null;
            await ctx.reply("👷‍♂️ **Modo VENDEDOR iniciado.**");
            return mostrarMenuPrincipal(ctx);
        } else {
            return ctx.reply("❌ Acceso denegado. PIN incorrecto.");
        }
    }

    if (!estado.autenticado) return ctx.reply("⚠️ Por favor ejecuta /start para ingresar al sistema.");

    // ==========================================
    // FLUJO: EDITAR PRECIO DE ITEM EN CARRITO
    // ==========================================
    if (estado.esperando === 'editar_precio_item') {
        if (texto.toLowerCase() === 'cancelar') {
            estado.esperando = null;
            estado.temp = null;
            return mostrarCarrito(ctx, estado);
        }
        
        const partes = texto.split(/[,;]/).map(p => p.trim());
        if (partes.length < 2) {
            return ctx.reply("❌ Formato incorrecto. Usa: `número, precio`");
        }
        
        const num = parseInt(partes[0]) - 1;
        const nuevoPrecio = parseFloat(partes[1].replace(',', '.'));
        
        if (isNaN(num) || num < 0 || num >= estado.carrito.length) {
            return ctx.reply("❌ Número de producto inválido.");
        }
        
        if (isNaN(nuevoPrecio) || nuevoPrecio <= 0) {
            return ctx.reply("❌ Precio inválido. Debe ser mayor a 0.");
        }
        
        const item = estado.carrito[num];
        const precioAnterior = item.precio;
        item.precio = formatearNumero(nuevoPrecio);
        item.precioPersonalizado = nuevoPrecio;
        item.precioOriginal = item.precioOriginal || precioAnterior;
        
        estado.esperando = null;
        estado.temp = null;
        
        const total = estado.carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0);
        
        let mensaje = `✅ **Precio actualizado:**\n`;
        mensaje += `📦 ${item.nombre}\n`;
        mensaje += `💰 Precio anterior: ${fmt(precioAnterior)}\n`;
        mensaje += `💵 Nuevo precio: ${fmt(item.precio)}\n`;
        mensaje += `📊 Nuevo subtotal: ${fmt(item.precio * item.cantidad)}\n`;
        mensaje += `🛒 Total carrito: ${fmt(total)}`;
        
        await ctx.reply(mensaje, { parse_mode: 'Markdown' });
        return mostrarCarrito(ctx, estado);
    }

    // ==========================================
    // FLUJO: DESCUENTO GLOBAL AL CARRITO
    // ==========================================
    if (estado.esperando === 'descuento_global') {
        if (texto.toLowerCase() === 'cancelar') {
            estado.esperando = null;
            estado.temp = null;
            return mostrarCarrito(ctx, estado);
        }
        
        const partes = texto.split(/[,;]/).map(p => p.trim());
        if (partes.length < 2) {
            return ctx.reply("❌ Formato incorrecto. Usa: `tipo, valor`\nEjemplos:\n`porcentaje, 10` (10% de descuento)\n`fijo, 5` (S/.5 de descuento)");
        }
        
        const tipo = partes[0].toLowerCase();
        const valor = parseFloat(partes[1].replace(',', '.'));
        
        if (isNaN(valor) || valor <= 0) {
            return ctx.reply("❌ Valor inválido. Debe ser mayor a 0.");
        }
        
        if (tipo !== 'porcentaje' && tipo !== 'fijo' && tipo !== '%' && tipo !== 's/') {
            return ctx.reply("❌ Tipo inválido. Usa: `porcentaje` o `fijo`");
        }
        
        let totalAhorro = 0;
        let mensaje = "✅ **Descuento global aplicado:**\n\n";
        
        if (tipo === 'porcentaje' || tipo === '%') {
            const porcentaje = valor;
            if (porcentaje < 0 || porcentaje > 100) {
                return ctx.reply("❌ El porcentaje debe ser entre 0 y 100.");
            }
            
            estado.carrito.forEach(item => {
                const descuento = item.precio * (porcentaje / 100);
                item.precio = formatearNumero(item.precio - descuento);
                item.descuentoPorcentaje = (item.descuentoPorcentaje || 0) + porcentaje;
                totalAhorro += descuento * item.cantidad;
            });
            
            mensaje += `📊 Descuento del ${porcentaje}% aplicado a todos los productos\n`;
        } else if (tipo === 'fijo' || tipo === 's/') {
            const descuentoFijo = valor;
            const totalItems = estado.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
            
            estado.carrito.forEach(item => {
                const subtotal = item.precio * item.cantidad;
                const proporcion = subtotal / totalItems;
                const descuentoItem = descuentoFijo * proporcion;
                const descuentoUnitario = descuentoItem / item.cantidad;
                
                item.precio = formatearNumero(item.precio - descuentoUnitario);
                item.descuentoFijo = (item.descuentoFijo || 0) + descuentoFijo * proporcion;
                totalAhorro += descuentoItem;
            });
            
            mensaje += `💰 Descuento fijo de S/. ${descuentoFijo.toFixed(2)} aplicado al total\n`;
        }
        
        const nuevoTotal = estado.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
        mensaje += `💵 Total ahorro: ${fmt(totalAhorro)}\n`;
        mensaje += `🛒 Nuevo total: ${fmt(nuevoTotal)}`;
        
        estado.esperando = null;
        estado.temp = null;
        
        await ctx.reply(mensaje, { parse_mode: 'Markdown' });
        return mostrarCarrito(ctx, estado);
    }

    // ==========================================
    // FLUJO: BUSCAR PRODUCTOS
    // ==========================================
    if (estado.esperando === 'busqueda') {
        ctx.reply("⏳ Buscando...");
        try {
            const { data: productos, error } = await supabase.rpc('buscar_productos_ferreteria', { 
                termino_busqueda: texto 
            });
            
            if (error) {
                console.error("Error en búsqueda:", error);
                return ctx.reply("❌ Error al buscar productos.");
            }
            
            if (!productos || productos.length === 0) {
                return ctx.reply("❌ No se encontraron coincidencias.");
            }

            estado.resultadosBusqueda = productos;
            estado.esperando = 'numero';
            estado.paginaActual = 1;

            return mostrarPaginaProductos(ctx, productos, 1, true);
        } catch (error) {
            console.error("Error en búsqueda:", error);
            return ctx.reply("❌ Error al buscar productos.");
        }
    }

    // ==========================================
// FLUJO: AGREGAR AL CARRITO CON TODAS LAS OPCIONES (CORREGIDO)
// ==========================================
    if (estado.esperando === 'numero') {
        // Limpiar y normalizar el texto
        const textoLimpio = texto.replace(/\s+/g, ' ').trim();
        const partes = textoLimpio.split(/[,;]/).map(p => p.trim());
        
        // Extraer el número de producto (siempre el primer número)
        const primerNumero = partes[0].match(/\d+/);
        if (!primerNumero) {
            return ctx.reply("❌ Selección inválida. Envía el número de producto.");
        }
        
        const opcion = parseInt(primerNumero[0]) - 1;
        
        // Extraer cantidad (segundo número en el texto)
        let cantidadAAgregar = 1;
        let descuentoPorcentaje = 0;
        let descuentoFijo = 0;
        let precioPersonalizado = null;
        let usarPrecioSugerido = false;
        
        // Buscar en todas las partes
        let numerosEncontrados = [];
        let tienePrecio = false;
        
        for (let i = 0; i < partes.length; i++) {
            const parte = partes[i].toLowerCase().trim();
            
            // Verificar si es un número puro (solo dígitos o decimales)
            const esNumeroPuro = /^\d+$/.test(parte) || /^\d+\.\d+$/.test(parte);
            
            // Si es un número puro y no hemos asignado cantidad aún
            if (esNumeroPuro && !parte.includes('precio') && !parte.includes('desc') && !parte.includes('sugerido')) {
                const num = parseFloat(parte);
                if (num > 0) {
                    // Si ya tenemos una opción, este es la cantidad
                    if (numerosEncontrados.length === 0) {
                        // Este es el número de producto (ya lo tenemos)
                        numerosEncontrados.push(num);
                    } else if (numerosEncontrados.length === 1 && cantidadAAgregar === 1) {
                        // Este es la cantidad
                        cantidadAAgregar = parseInt(num);
                        numerosEncontrados.push(num);
                    }
                }
            }
            
            // Buscar precio personalizado
            if (parte.includes('precio')) {
                const precioMatch = parte.match(/\d+\.?\d*/);
                if (precioMatch) {
                    precioPersonalizado = parseFloat(precioMatch[0]);
                    if (precioPersonalizado <= 0) {
                        return ctx.reply("❌ El precio debe ser mayor a 0.");
                    }
                    tienePrecio = true;
                }
            }
            
            // Buscar precio sugerido
            if (parte.includes('sugerido') || parte.includes('sug')) {
                usarPrecioSugerido = true;
            }
            
            // Buscar descuento porcentual
            if ((parte.includes('desc') || parte.includes('%')) && !parte.includes('global')) {
                const descMatch = parte.match(/\d+/);
                if (descMatch) {
                    descuentoPorcentaje = parseFloat(descMatch[0]);
                    if (descuentoPorcentaje < 0 || descuentoPorcentaje > 100) {
                        return ctx.reply("❌ El descuento porcentual debe ser entre 0 y 100%.");
                    }
                }
            }
            
            // Buscar descuento fijo al total
            if ((parte.includes('s/') || parte.includes('$') || parte.includes('descuento')) && 
                !parte.includes('%') && !parte.includes('global') && !parte.includes('precio')) {
                const descMatch = parte.match(/\d+\.?\d*/);
                if (descMatch) {
                    descuentoFijo = parseFloat(descMatch[0]);
                    if (descuentoFijo < 0) {
                        return ctx.reply("❌ El descuento fijo debe ser mayor a 0.");
                    }
                }
            }
        }
        
        // Si no se encontró cantidad en el parsing, intentar extraer del texto completo
        if (cantidadAAgregar === 1) {
            // Buscar todos los números en el texto
            const todosNumeros = texto.match(/\d+/g);
            if (todosNumeros && todosNumeros.length >= 2) {
                // El segundo número podría ser la cantidad
                cantidadAAgregar = parseInt(todosNumeros[1]);
            }
        }
        
        // Validar cantidad
        if (isNaN(cantidadAAgregar) || cantidadAAgregar < 1) {
            cantidadAAgregar = 1;
        }
        
        // --- Resto del código igual ---
        const productos = estado.resultadosBusqueda;
        if (!productos || opcion < 0 || opcion >= productos.length) {
            return ctx.reply("❌ Opción inválida de la lista.");
        }

        const prodElegido = productos[opcion];
        
        if (cantidadAAgregar > prodElegido.stock) {
            return ctx.reply(`⚠️ Stock insuficiente. Solo quedan ${prodElegido.stock} unidades.`);
        }

        let precioFinal = prodElegido.precio_venta;
        let precioSugerido = null;
        
        if (usarPrecioSugerido) {
            precioSugerido = calcularPrecioSugerido(
                prodElegido.precio_venta,
                cantidadAAgregar,
                prodElegido.precio_costo || 0
            );
            precioFinal = precioSugerido;
        }
        
        if (precioPersonalizado !== null) {
            precioFinal = precioPersonalizado;
        }
        
        let descuentoUnitario = 0;
        let descuentoTotal = 0;
        
        if (descuentoPorcentaje > 0) {
            descuentoUnitario = precioFinal * (descuentoPorcentaje / 100);
        }
        
        if (descuentoFijo > 0) {
            descuentoUnitario += (descuentoFijo / cantidadAAgregar);
        }
        
        precioFinal = precioFinal - descuentoUnitario;
        precioFinal = formatearNumero(precioFinal);
        
        descuentoTotal = (descuentoPorcentaje > 0 ? (precioPersonalizado || prodElegido.precio_venta) * (descuentoPorcentaje / 100) : 0) + (descuentoFijo > 0 ? descuentoFijo : 0);
        descuentoTotal = formatearNumero(descuentoTotal);

        // Verificar si ya existe en el carrito
        const itemExistente = estado.carrito.find(item => item.id === prodElegido.id);
        const cantidadTotal = (itemExistente ? itemExistente.cantidad : 0) + cantidadAAgregar;

        if (itemExistente) {
            if (cantidadTotal > prodElegido.stock) {
                return ctx.reply(`⚠️ Stock insuficiente. Solo quedan ${prodElegido.stock} unidades.`);
            }
            itemExistente.cantidad = cantidadTotal;
            itemExistente.precio = precioFinal;
            itemExistente.descuentoPorcentaje = (itemExistente.descuentoPorcentaje || 0) + descuentoPorcentaje;
            itemExistente.descuentoFijo = (itemExistente.descuentoFijo || 0) + descuentoFijo;
            if (precioPersonalizado !== null) {
                itemExistente.precioPersonalizado = precioPersonalizado;
            }
            if (precioSugerido !== null) {
                itemExistente.precioSugerido = precioSugerido;
            }
            itemExistente.descuentoTotal = (itemExistente.descuentoTotal || 0) + descuentoTotal;
        } else {
            const nuevoItem = {
                id: prodElegido.id,
                nombre: prodElegido.nombre,
                marca: prodElegido.marca,
                precio: precioFinal,
                cantidad: cantidadAAgregar,
                precioOriginal: prodElegido.precio_venta,
                costo_unitario: prodElegido.precio_costo || 0,
                descuentoPorcentaje: descuentoPorcentaje || 0,
                descuentoFijo: descuentoFijo || 0,
                descuentoTotal: descuentoTotal || 0,
                precioPersonalizado: precioPersonalizado || null,
                precioSugerido: precioSugerido || null
            };
            estado.carrito.push(nuevoItem);
        }

        estado.esperando = null;
        
        let mensaje = `✅ **${prodElegido.nombre}** x${cantidadAAgregar} agregado al carrito`;
        
        if (precioSugerido !== null) {
            mensaje += `\n📊 Precio sugerido por cantidad: ${fmt(precioSugerido)}`;
            mensaje += `\n📊 Precio original: ${fmt(prodElegido.precio_venta)}`;
        }
        if (precioPersonalizado !== null) {
            mensaje += `\n💰 Precio personalizado: ${fmt(precioPersonalizado)}`;
            mensaje += `\n📊 Precio original: ${fmt(prodElegido.precio_venta)}`;
        }
        if (descuentoPorcentaje > 0) {
            mensaje += `\n💰 Descuento por unidad: ${descuentoPorcentaje}%`;
        }
        if (descuentoFijo > 0) {
            mensaje += `\n💰 Descuento al total: S/. ${descuentoFijo.toFixed(2)}`;
        }
        if (descuentoTotal > 0) {
            mensaje += `\n💵 Ahorro total: ${fmt(descuentoTotal)}`;
        }
        mensaje += `\n💵 Precio final por unidad: ${fmt(precioFinal)}`;
        mensaje += `\n📦 Stock restante: ${prodElegido.stock - cantidadAAgregar}`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔍 Seguir agregando", callback_data: "seguir_agregando" }],
                [{ text: "🛒 Ver carrito", callback_data: "ver_carrito" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };
        
        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
    }


    // ==========================================
    // 👑 FLUJO ADMIN: REGISTRAR PRODUCTO NUEVO
    // ==========================================
    if (estado.esperando?.startsWith('agregar_')) {
        if (estado.esperando === 'agregar_nombre') {
            if (texto.length < 2) return ctx.reply("❌ El nombre debe tener al menos 2 caracteres.");
            estado.temp.nombre = texto;
            estado.esperando = 'agregar_marca';
            return ctx.reply("📦 Escribe la MARCA del producto:");
        }
        
        if (estado.esperando === 'agregar_marca') {
            if (texto.length < 1) return ctx.reply("❌ La marca es obligatoria.");
            estado.temp.marca = texto;
            estado.esperando = 'agregar_costo';
            return ctx.reply("💰 Escribe el PRECIO DE COSTO:\nEjemplo: `15.50` o `20`");
        }
        
        if (estado.esperando === 'agregar_costo') {
            const val = parseFloat(texto.replace(',', '.'));
            if (isNaN(val) || val <= 0) {
                return ctx.reply("❌ Número inválido. Ingresa un precio mayor a 0:");
            }
            estado.temp.precio_costo = formatearNumero(val);
            estado.esperando = 'agregar_precio';
            return ctx.reply("💵 Escribe el PRECIO DE VENTA:\nEjemplo: `25.90` o `30`");
        }
        
        if (estado.esperando === 'agregar_precio') {
            const val = parseFloat(texto.replace(',', '.'));
            if (isNaN(val) || val <= 0) {
                return ctx.reply("❌ Número inválido. Ingresa un precio mayor a 0:");
            }
            if (val <= estado.temp.precio_costo) {
                return ctx.reply(`⚠️ El precio de venta (${fmt(val)}) debe ser mayor al costo (${fmt(estado.temp.precio_costo)}).`);
            }
            estado.temp.precio_venta = formatearNumero(val);
            estado.esperando = 'agregar_stock';
            return ctx.reply("🔢 Escribe el STOCK INICIAL:\nEjemplo: `100`");
        }
        
        if (estado.esperando === 'agregar_stock') {
            const val = parseInt(texto);
            if (isNaN(val) || val < 0) return ctx.reply("❌ Cantidad inválida. Ingresa un número válido:");
            estado.temp.stock = val;

            ctx.reply("⏳ Guardando en la base de datos...");
            const { error } = await supabase.from('productos').insert([estado.temp]);

            if (error) {
                console.error("🔴 Error Supabase:", error);
                return ctx.reply("❌ Error al guardar. Verifica que no exista un producto con el mismo nombre.");
            }

            await ctx.reply(
                `✅ **¡Producto Creado Exitosamente!**\n\n` +
                `📦 *${estado.temp.nombre}*\n` +
                `🏭 Marca: ${estado.temp.marca}\n` +
                `💰 Costo: ${fmt(estado.temp.precio_costo)} | Venta: ${fmt(estado.temp.precio_venta)}\n` +
                `🔢 Stock: ${val}`,
                { parse_mode: 'Markdown' }
            );
            estado.esperando = null;
            estado.temp = null;
            return mostrarMenuPrincipal(ctx);
        }
    }

    // ==========================================
    // 👑 FLUJO ADMIN: EDITAR PRODUCTO
    // ==========================================
    if (estado.esperando === 'editar_buscar') {
        try {
            const { data: productos, error } = await supabase.rpc('buscar_productos_ferreteria', { 
                termino_busqueda: texto 
            });
            
            if (error) {
                console.error("Error en búsqueda para editar:", error);
                return ctx.reply("❌ Error al buscar productos.");
            }
            
            if (!productos || productos.length === 0) {
                return ctx.reply("❌ No se encontró el producto.");
            }

            estado.resultadosBusqueda = productos;
            estado.esperando = 'editar_seleccion';

            let r = "📝 **Selecciona qué producto quieres editar:**\n\n";
            productos.forEach((p, idx) => {
                r += mostrarProducto(p, idx);
            });
            r += "\n🔢 Escribe el número del producto:";
            return ctx.reply(r, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error("Error:", error);
            return ctx.reply("❌ Error al buscar productos.");
        }
    }

    if (estado.esperando === 'editar_seleccion') {
        const num = parseInt(texto) - 1;
        const productos = estado.resultadosBusqueda;
        
        if (!productos || num < 0 || num >= productos.length) {
            return ctx.reply("❌ Selección inválida de la lista.");
        }

        estado.temp = productos[num];
        estado.esperando = 'editar_ejecutar';

        let m = `🛠️ **Producto Seleccionado:**\n`;
        m += mostrarProducto(estado.temp);
        m += `\n**¿Qué deseas modificar?**\n\n`;
        m += `Escribe el campo y el nuevo valor:\n`;
        m += `• \`stock 150\` - Actualizar stock\n`;
        m += `• \`costo 12.50\` - Actualizar costo\n`;
        m += `• \`precio 25.90\` - Actualizar precio de venta\n`;
        m += `• \`todos 100 15.50 25.90\` - Actualizar todos\n\n`;
        m += `💡 *Puedes usar comas o puntos para decimales*`;
        return ctx.reply(m, { parse_mode: 'Markdown' });
    }

    if (estado.esperando === 'editar_ejecutar') {
        const partes = texto.split(/\s+/);
        if (partes.length < 2) {
            return ctx.reply("❌ Formato incorrecto. Usa: `stock 50` o `costo 19.90`.");
        }

        const campo = partes[0].toLowerCase();
        const updateObj = {};
        let mensajeConfirmacion = '';

        if (campo === 'todos' && partes.length >= 4) {
            const stock = parseInt(partes[1]);
            const costo = parseFloat(partes[2].replace(',', '.'));
            const precio = parseFloat(partes[3].replace(',', '.'));
            
            if (isNaN(stock) || stock < 0) return ctx.reply("❌ Stock inválido.");
            if (isNaN(costo) || costo <= 0) return ctx.reply("❌ Costo inválido.");
            if (isNaN(precio) || precio <= 0) return ctx.reply("❌ Precio inválido.");
            if (precio <= costo) return ctx.reply(`⚠️ El precio de venta debe ser mayor al costo.`);
            
            updateObj.stock = stock;
            updateObj.precio_costo = formatearNumero(costo);
            updateObj.precio_venta = formatearNumero(precio);
            
            mensajeConfirmacion = 
                `🔢 Stock: **${stock}**\n` +
                `💰 Costo: ${fmt(costo)}\n` +
                `💵 Precio Venta: ${fmt(precio)}`;
        } else {
            const valorInput = parseFloat(partes[1].replace(',', '.'));
            if (isNaN(valorInput)) return ctx.reply("❌ El valor debe ser un número válido.");

            if (campo === 'stock') {
                if (valorInput < 0 || !Number.isInteger(valorInput)) {
                    return ctx.reply("❌ El stock debe ser un número entero positivo.");
                }
                updateObj.stock = parseInt(valorInput);
                mensajeConfirmacion = `🔢 Stock actualizado a: **${parseInt(valorInput)}**`;
            } else if (campo === 'costo') {
                if (isNaN(valorInput) || valorInput <= 0) return ctx.reply("❌ El costo debe ser mayor a 0.");
                updateObj.precio_costo = formatearNumero(valorInput);
                if (estado.temp.precio_venta <= updateObj.precio_costo) {
                    return ctx.reply(`⚠️ El precio de venta (${fmt(estado.temp.precio_venta)}) debe ser mayor al nuevo costo (${fmt(updateObj.precio_costo)}).`);
                }
                mensajeConfirmacion = `💰 Costo actualizado a: **${fmt(updateObj.precio_costo)}**`;
            } else if (campo === 'precio') {
                if (isNaN(valorInput) || valorInput <= 0) return ctx.reply("❌ El precio debe ser mayor a 0.");
                updateObj.precio_venta = formatearNumero(valorInput);
                if (updateObj.precio_venta <= estado.temp.precio_costo) {
                    return ctx.reply(`⚠️ El nuevo precio (${fmt(updateObj.precio_venta)}) debe ser mayor al costo (${fmt(estado.temp.precio_costo)}).`);
                }
                mensajeConfirmacion = `💵 Precio de venta actualizado a: **${fmt(updateObj.precio_venta)}**`;
            } else {
                return ctx.reply("❌ Campo inválido. Usa: `stock`, `costo`, `precio` o `todos`.");
            }
        }

        ctx.reply("⏳ Actualizando base de datos...");

        try {
            const { error } = await supabase
                .from('productos')
                .update(updateObj)
                .eq('id', estado.temp.id);

            if (error) {
                console.error("🔴 Error de actualización:", error);
                return ctx.reply("❌ Error al actualizar el producto en Supabase.");
            }

            const { data: productoActualizado } = await supabase
                .from('productos')
                .select('*')
                .eq('id', estado.temp.id)
                .single();

            await ctx.reply(
                `✅ **¡Modificación Exitosa!**\n\n` +
                `📦 Producto: *${estado.temp.nombre}*\n` +
                `${mensajeConfirmacion}\n\n` +
                `📊 **Estado Actual:**\n` +
                `💰 Costo: ${fmt(productoActualizado?.precio_costo || estado.temp.precio_costo)}\n` +
                `💵 Venta: ${fmt(productoActualizado?.precio_venta || estado.temp.precio_venta)}\n` +
                `🔢 Stock: ${productoActualizado?.stock || estado.temp.stock}`,
                { parse_mode: 'Markdown' }
            );

            estado.esperando = null;
            estado.temp = null;
            estado.resultadosBusqueda = null;
            return mostrarMenuPrincipal(ctx);
        } catch (error) {
            console.error("Error al actualizar:", error);
            return ctx.reply("❌ Error al actualizar el producto.");
        }
    }

    // ==========================================
    // FLUJO ADMIN: REGISTRAR COMPRA
    // ==========================================
    if (estado.esperando === 'compra_buscar') {
        estado.temp = { proveedor: texto, items: [] };
        estado.esperando = 'compra_productos';
        return ctx.reply(
            "📦 **Registrar Compra**\n\n" +
            "Ahora busca los productos:\n" +
            "Escribe el NOMBRE del producto a comprar:",
            { parse_mode: 'Markdown' }
        );
    }

    if (estado.esperando === 'compra_productos') {
        if (texto.toLowerCase() === 'terminar') {
            if (!estado.temp.items || estado.temp.items.length === 0) {
                return ctx.reply("❌ No hay productos en la compra.");
            }
            
            ctx.reply("⏳ Registrando compra...");
            
            try {
                const items = estado.temp.items.map(item => ({
                    id: item.id,
                    cantidad: item.cantidad,
                    precio: item.precio
                }));

                const { data: compraId, error } = await supabase.rpc('registrar_compra', {
                    p_proveedor: estado.temp.proveedor,
                    p_items: items,
                    p_usuario: estado.rol || 'ADMINISTRADOR'
                });

                if (error) {
                    console.error("Error al registrar compra:", error);
                    return ctx.reply(`❌ Error al registrar la compra: ${error.message}`);
                }

                let mensaje = `✅ **COMPRA REGISTRADA EXITOSAMENTE**\n`;
                mensaje += `📝 #${compraId}\n`;
                mensaje += `🏢 Proveedor: ${estado.temp.proveedor}\n`;
                mensaje += `👤 Usuario: ${estado.rol}\n`;
                mensaje += `-----------------------------------\n`;
                let totalCompra = 0;
                estado.temp.items.forEach(item => {
                    const subtotal = item.precio * item.cantidad;
                    totalCompra += subtotal;
                    mensaje += `• ${item.nombre} x${item.cantidad} = ${fmt(subtotal)}\n`;
                });
                mensaje += `-----------------------------------\n`;
                mensaje += `💰 Total Compra: ${fmt(totalCompra)}`;

                estado.temp = null;
                estado.esperando = null;
                
                await ctx.reply(mensaje, { parse_mode: 'Markdown' });
                return mostrarMenuPrincipal(ctx);

            } catch (error) {
                console.error("Error:", error);
                return ctx.reply(`❌ Error al registrar la compra: ${error.message}`);
            }
        }

        const { data: productos, error } = await supabase
            .from('productos')
            .select('id, nombre, marca, precio_costo')
            .ilike('nombre', `%${texto}%`)
            .limit(5);

        if (error || !productos || productos.length === 0) {
            return ctx.reply("❌ Producto no encontrado. Intenta con otro nombre o escribe 'terminar' para finalizar.");
        }

        let mensaje = "🔍 **Productos encontrados:**\n\n";
        productos.forEach((p, i) => {
            mensaje += `${i+1}. ${p.nombre} (${p.marca}) - Costo: ${fmt(p.precio_costo)}\n`;
        });
        mensaje += `\nEscribe el número del producto y la cantidad (Ej: "1, 10"):\n`;
        mensaje += `O escribe "terminar" para finalizar la compra.`;

        estado.temp.productosEncontrados = productos;
        estado.esperando = 'compra_seleccionar';
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    if (estado.esperando === 'compra_seleccionar') {
        const partes = texto.split(/[,;]/).map(p => p.trim());
        const num = parseInt(partes[0]) - 1;
        const cantidad = parseInt(partes[1]) || 1;

        const productos = estado.temp.productosEncontrados;
        if (!productos || num < 0 || num >= productos.length) {
            return ctx.reply("❌ Selección inválida.");
        }

        const producto = productos[num];
        
        if (!estado.temp.items) estado.temp.items = [];
        estado.temp.items.push({
            id: producto.id,
            nombre: producto.nombre,
            cantidad: cantidad,
            precio: producto.precio_costo
        });

        ctx.reply(`✅ ${producto.nombre} x${cantidad} agregado a la compra.`);
        estado.esperando = 'compra_productos';
        return ctx.reply("📦 Escribe el NOMBRE del siguiente producto o 'terminar' para finalizar:");
    }

    // ==========================================
    // FLUJO: MOVIMIENTOS POR PRODUCTO
    // ==========================================
    if (estado.esperando === 'movimientos_producto_buscar') {
        return mostrarMovimientosProducto(ctx, texto);
    }
});

// ==========================================
// ACCIONES DE BOTONES (CALLBACK QUERY)
// ==========================================
bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id;
    const accion = ctx.callbackQuery.data;
    const estado = getEstado(userId);

    await ctx.answerCbQuery();

    // Iniciar sesión
    if (accion === 'iniciar_sesion') {
        limpiarCarrito(estado);
        estado.esperando = 'pin';
        return ctx.reply("🔐 Introduce tu PIN de acceso:");
    }

    // Cerrar sesión
    if (accion === 'cerrar_sesion') {
        estado.autenticado = false;
        estado.rol = null;
        limpiarCarrito(estado);
        
        return ctx.reply("👋 Sesión cerrada correctamente.\n\n🛒 El carrito ha sido vaciado.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔐 Iniciar Sesión", callback_data: "iniciar_sesion" }]
                ]
            }
        });
    }

    // Menú principal
    if (accion === 'menu_principal') {
        limpiarCarrito(estado);
        return mostrarMenuPrincipal(ctx);
    }

    // Buscar productos
    if (accion === 'buscar_productos') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca del producto que deseas buscar:");
    }

    // Ver inventario
    if (accion === 'ver_inventario') {
        ctx.reply("📊 Consultando el inventario completo...");
        const { data: productos, error } = await supabase
            .from('productos')
            .select('*')
            .order('nombre', { ascending: true });

        if (error) {
            console.error("Error en inventario:", error);
            return ctx.reply("❌ Ocurrió un error al consultar el catálogo.");
        }
        if (!productos || productos.length === 0) return ctx.reply("📦 El inventario está vacío.");

        estado.resultadosBusqueda = productos;
        estado.esperando = 'numero';
        estado.paginaActual = 1;

        return mostrarPaginaProductos(ctx, productos, 1);
    }

    // Ver carrito
    if (accion === 'ver_carrito') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 El carrito está vacío.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔍 Buscar Productos", callback_data: "buscar_productos" }],
                        [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
                    ]
                }
            });
        }
        return mostrarCarrito(ctx, estado);
    }

    // Vaciar carrito
    if (accion === 'vaciar_carrito') {
        limpiarCarrito(estado);
        return ctx.reply("🗑️ Carrito vaciado correctamente.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔍 Buscar Productos", callback_data: "buscar_productos" }],
                    [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
                ]
            }
        });
    }

    // Editar precio del carrito
    if (accion === 'editar_precio_carrito') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 El carrito está vacío.");
        }
        
        let mensaje = "✏️ **EDITAR PRECIO DE PRODUCTO**\n\n";
        mensaje += "Selecciona el número del producto y escribe el nuevo precio:\n\n";
        
        estado.carrito.forEach((item, index) => {
            const sub = item.precio * item.cantidad;
            mensaje += `${index + 1}. ${item.nombre} — `;
            mensaje += `Precio actual: ${fmt(item.precio)}`;
            if (item.precioPersonalizado) {
                mensaje += ` ⚠️ (Personalizado)`;
            }
            if (item.precioSugerido) {
                mensaje += ` 📊 (Sugerido: ${fmt(item.precioSugerido)})`;
            }
            mensaje += `\n`;
        });
        
        mensaje += `\n📝 **Formato:** \`número, nuevo_precio\``;
        mensaje += `\nEjemplo: \`1, 15.50\``;
        mensaje += `\nO escribe \`cancelar\` para volver.`;
        
        estado.esperando = 'editar_precio_item';
        estado.temp = { editando: true };
        
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    // Descuento global al carrito
    if (accion === 'descuento_global') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 El carrito está vacío.");
        }
        
        let mensaje = "🏷️ **DESCUENTO GLOBAL AL CARRITO**\n\n";
        mensaje += "Aplica un descuento a TODOS los productos del carrito.\n\n";
        mensaje += "📝 **Formatos:**\n";
        mensaje += "• `porcentaje, 10` - 10% de descuento a todos\n";
        mensaje += "• `fijo, 5` - S/.5 de descuento al total\n\n";
        mensaje += "💡 *El descuento se reparte proporcionalmente entre todos los productos.*\n";
        mensaje += `🛒 Total actual: ${fmt(estado.carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0))}\n\n`;
        mensaje += "Escribe `cancelar` para volver.";
        
        estado.esperando = 'descuento_global';
        
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    // 👑 COMANDOS DE ADMINISTRADOR
    if (accion === 'agregar_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        estado.esperando = 'agregar_nombre';
        estado.temp = {};
        return ctx.reply("🛠️ **[Alta de Producto]** Escribe el NOMBRE del nuevo artículo:");
    }

    if (accion === 'editar_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        estado.esperando = 'editar_buscar';
        return ctx.reply("📝 **[Modificar Inventario]** Escribe el nombre o marca del producto que quieres alterar:");
    }

    if (accion === 'ver_ganancias') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        
        ctx.reply("📊 Calculando balance financiero de hoy...");
        
        const inicioHoy = new Date(); 
        inicioHoy.setHours(0,0,0,0);
        const finHoy = new Date(); 
        finHoy.setHours(23,59,59,999);

        const { data: ventas, error: errVentas } = await supabase
            .from('ventas')
            .select('*')
            .gte('created_at', inicioHoy.toISOString())
            .lte('created_at', finHoy.toISOString());

        if (errVentas) {
            console.error("🔴 Error al obtener ventas de hoy:", errVentas);
            return ctx.reply("❌ Error al extraer las ventas de Supabase.");
        }

        if (!ventas || ventas.length === 0) {
            let r = `💰 **REPORTE FINANCIERO DIARIO**\n`;
            r += `📅 _Fecha: ${new Date().toLocaleDateString()}_\n`;
            r += `-----------------------------------\n`;
            r += `📦 **Transacciones Realizadas:** 0\n`;
            r += `💵 **Ingresos Brutos (Caja):** S/. 0.00\n`;
            r += `📉 **Costo de Mercancía Vendida:** S/. 0.00\n`;
            r += `-----------------------------------\n`;
            r += `📈 **GANANCIA NETA DEL DÍA:** S/. 0.00\n\n`;
            r += `🛒 **Desglose por Métodos de Pago:**\n`;
            r += `• 💵 Efectivo: S/. 0.00\n`;
            r += `• 💳 Tarjeta: S/. 0.00\n`;
            r += `• 📱 Transferencia: S/. 0.00`;
            return ctx.reply(r, { parse_mode: 'Markdown' });
        }

        const idsVentas = ventas.map(v => v.id);
        const { data: detalles, error: errDetalles } = await supabase
            .from('detalles_ventas')
            .select('cantidad, precio_unitario, productos!fk_detalles_productos(precio_costo)')
            .in('venta_id', idsVentas);

        if (errDetalles) {
            console.error("🔴 Error al desglosar los costos detallados:", errDetalles);
            return ctx.reply("❌ Error al calcular el desglose de utilidades.");
        }

        let ingresosTotales = 0;
        let costosTotales = 0;
        let metodos = { Efectivo: 0, Tarjeta: 0, Transferencia: 0 };

        ventas.forEach(v => {
            ingresosTotales += parseFloat(v.total);
            if (metodos[v.metodo_pago] !== undefined) metodos[v.metodo_pago] += parseFloat(v.total);
        });

        detalles.forEach(d => {
            const costoUnitario = d.productos ? (parseFloat(d.productos.precio_costo) || 0) : 0;
            costosTotales += (costoUnitario * parseInt(d.cantidad));
        });

        const gananciaNeta = ingresosTotales - costosTotales;

        let r = `💰 **REPORTE FINANCIERO DIARIO**\n`;
        r += `📅 _Fecha: ${new Date().toLocaleDateString()}_\n`;
        r += `-----------------------------------\n`;
        r += `📦 **Transacciones:** ${ventas.length}\n`;
        r += `💵 **Ingresos Brutos (Caja):** S/. ${ingresosTotales.toFixed(2)}\n`;
        r += `📉 **Costo de lo Vendido:** S/. ${costosTotales.toFixed(2)}\n`;
        r += `-----------------------------------\n`;
        r += `📈 **GANANCIA NETA DEL DÍA:** S/. ${gananciaNeta.toFixed(2)}\n\n`;
        r += `🛒 **Desglose por Métodos de Pago:**\n`;
        r += `• 💵 Efectivo: S/. ${metodos.Efectivo.toFixed(2)}\n`;
        r += `• 💳 Tarjeta: S/. ${metodos.Tarjeta.toFixed(2)}\n`;
        r += `• 📱 Transferencia: S/. ${metodos.Transferencia.toFixed(2)}`;

        return ctx.reply(r, { parse_mode: 'Markdown' });
    }

    if (accion === 'ver_alertas') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }

        const { data: criticos, error } = await supabase
            .from('productos')
            .select('*')
            .lt('stock', 5)
            .order('stock', { ascending: true });

        if (error) return ctx.reply("❌ Error al consultar alarmas.");
        if (!criticos || criticos.length === 0) {
            return ctx.reply("✅ ¡Excelente! Todos los productos tienen stock saludable.");
        }

        let r = `⚠️ **ALERTAS DE REABASTECIMIENTO (< 5 Unid.)**\n\n`;
        criticos.forEach(p => {
            r += `• ${p.nombre} (${p.marca}) — Stock Actual: **${p.stock}**\n`;
        });
        return ctx.reply(r, { parse_mode: 'Markdown' });
    }

    if (accion === 'registrar_compra') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        estado.esperando = 'compra_buscar';
        estado.temp = { items: [], proveedor: '' };
        return ctx.reply(
            "📦 **REGISTRO DE COMPRA**\n\n" +
            "Escribe el NOMBRE del proveedor:",
            { parse_mode: 'Markdown' }
        );
    }

    if (accion === 'reporte_movimientos') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        return mostrarReporteMovimientos(ctx);
    }

    if (accion === 'resumen_inventario') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        return mostrarResumenInventario(ctx);
    }

    if (accion === 'movimientos_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        estado.esperando = 'movimientos_producto_buscar';
        return ctx.reply("🔍 Escribe el nombre del producto para ver sus movimientos:");
    }

    if (accion === 'reporte_movimientos_mas') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Comando exclusivo para el ADMINISTRADOR.");
        }
        return mostrarReporteMovimientos(ctx);
    }

    // Navegación de páginas
    if (accion.startsWith('pagina_')) {
        const pagina = parseInt(accion.split('_')[1]);
        if (estado.resultadosBusqueda) {
            return mostrarPaginaProductos(ctx, estado.resultadosBusqueda, pagina);
        }
        return;
    }

    // Seguir agregando productos
    if (accion === 'seguir_agregando') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca de la herramienta:");
    }

    // Volver a buscar
    if (accion === 'volver_busqueda') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca del producto:");
    }

    // Procesar pago
    if (accion.startsWith('pago_')) {
        const metodo = accion.split('_')[1];
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("⚠️ Carrito vacío.");
        }

        const totalVenta = estado.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
        const totalOriginal = estado.carrito.reduce((acc, item) => acc + ((item.precioOriginal || item.precio) * item.cantidad), 0);
        const totalCosto = estado.carrito.reduce((acc, item) => acc + ((item.costo_unitario || 0) * item.cantidad), 0);
        const totalAhorro = totalOriginal - totalVenta;
        
        ctx.reply("⏳ Procesando transacción...");

        try {
            const itemsArray = estado.carrito.map(item => ({
                id: item.id,
                cantidad: item.cantidad,
                precio: parseFloat(item.precio.toFixed(2)),
                precio_original: item.precioOriginal || item.precio,
                descuento_porcentaje: item.descuentoPorcentaje || 0,
                descuento_fijo: item.descuentoFijo || 0,
                precio_personalizado: item.precioPersonalizado || null,
                precio_sugerido: item.precioSugerido || null
            }));

            console.log("📦 Items a procesar:", JSON.stringify(itemsArray, null, 2));

            const { data: ventaId, error } = await supabase.rpc('procesar_venta', {
                p_total: parseFloat(totalVenta.toFixed(2)),
                p_metodo_pago: metodo,
                p_rol_vendedor: estado.rol || 'VENDEDOR',
                p_items: itemsArray
            });

            if (error) {
                console.error("❌ Error al procesar venta:", error);
                return ctx.reply(`❌ Error al procesar la venta: ${error.message || 'Error desconocido'}`);
            }

            let msg = `✅ **¡Venta Procesada!**\n`;
            msg += `📝 **Nota:** #${ventaId}\n`;
            msg += `👷‍♂️ **Atendió:** ${estado.rol}\n`;
            msg += `💳 **Pago:** ${metodo}\n`;
            msg += `-----------------------------------\n`;
            
            estado.carrito.forEach(item => {
                const subtotal = item.precio * item.cantidad;
                const subOriginal = (item.precioOriginal || item.precio) * item.cantidad;
                msg += `• ${item.nombre} x${item.cantidad}`;
                if (item.precioSugerido) {
                    msg += ` 📊 Precio sugerido: ${fmt(item.precioSugerido)}`;
                }
                if (item.descuentoPorcentaje > 0) {
                    msg += ` (${item.descuentoPorcentaje}% desc por unidad)`;
                }
                if (item.descuentoFijo > 0) {
                    msg += ` (S/. ${item.descuentoFijo.toFixed(2)} desc al total)`;
                }
                if (item.precioPersonalizado) {
                    msg += ` ⚠️ Precio personalizado: ${fmt(item.precioPersonalizado)}`;
                }
                if (subOriginal > subtotal) {
                    msg += ` — ${fmt(subtotal)} (antes ${fmt(subOriginal)})`;
                } else {
                    msg += ` — ${fmt(subtotal)}`;
                }
                msg += `\n`;
            });
            
            msg += `-----------------------------------\n`;
            msg += `💰 **Total Ingreso:** ${fmt(totalVenta)}\n`;
            if (totalAhorro > 0) {
                msg += `💵 **Descuento total:** ${fmt(totalAhorro)}\n`;
                msg += `📊 **Total sin descuentos:** ${fmt(totalOriginal)}\n`;
            }
            msg += `📉 **Total Costo:** ${fmt(totalCosto)}\n`;
            msg += `📈 **Utilidad Bruta:** ${fmt(totalVenta - totalCosto)}`;

            limpiarCarrito(estado);
            
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            return mostrarMenuPrincipal(ctx);
        } catch (error) {
            console.error("❌ Error en pago:", error);
            return ctx.reply(`❌ Error al procesar el pago: ${error.message || 'Error desconocido'}`);
        }
    }
});

// ==========================================
// SERVIDOR WEB PARA RENDER (AUXILIAR)
// ==========================================
// Este servidor mantiene vivo el bot en Render
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`✅ Servidor web auxiliar escuchando en el puerto ${port}`);
});

// ==========================================
// INICIO DEL BOT
// ==========================================
bot.launch()
    .then(() => {
        console.log("🚀 Sistema POS Ejecutivo en línea...");
        console.log("✅ Bot iniciado correctamente");
        console.log("📌 Comandos disponibles: /start, /menu");
        console.log("👑 Admin PIN: 0316 (PRIVADO)");
        console.log("👷 Vendedor PIN: 1234 (PRIVADO)");
        console.log("⚠️ Los PINs NO son visibles para los usuarios");
        console.log("🎯 Todos los comandos son botones interactivos");
        console.log("📊 Sistema de reportes de inventario activo");
        console.log("✏️ Edición de precios en ventas activada");
        console.log("🏷️ Precios sugeridos por cantidad activados");
        console.log("💰 Descuentos globales al carrito activados");
        console.log("🗑️ Carrito se limpia automáticamente al salir");
    })
    .catch((error) => {
        console.error("❌ Error al iniciar el bot:", error);
        process.exit(1);
    });

// Manejo de señales de terminación
process.once('SIGINT', () => {
    console.log("🛑 Bot detenido por SIGINT");
    bot.stop('SIGINT');
    server.close();
});
process.once('SIGTERM', () => {
    console.log("🛑 Bot detenido por SIGTERM");
    bot.stop('SIGTERM');
    server.close();
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error("❌ Error no capturado:", error);
});

console.log("✅ Script cargado correctamente");